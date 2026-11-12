use rusqlite::params;
use vst_types::NormalizedEvent;

use crate::transcript::TranscriptStore;

pub const WINDOW_TURNS: i64 = 15;
pub const WINDOW_BYTE_BUDGET: usize = 300 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AroundPage {
    pub events: Vec<NormalizedEvent>,
    pub oldest_seq: Option<i64>,
    pub has_more: bool,
    pub turns_before: i64,
}

/// SQL expression for a row's turn identity: its `turn_id`, or the row itself for
/// legacy rows written without one (so those never merge into one giant turn).
pub(crate) const TURN_KEY_SQL: &str = "COALESCE(turn_id, 'seq:' || seq)";

/// SQL predicate selecting the rows that can open a window turn: rows of a
/// `turn_id` turn, and `user` rows without one. Any other row without a
/// `turn_id` (status, message_generated, task_signal, a legacy reply) belongs to
/// the turn before it, so it neither shrinks a window nor starts one mid-turn.
const TURN_START_ROWS_SQL: &str = "superseded = 0 AND (turn_id IS NOT NULL OR kind = 'user')";

/// SQL predicate selecting the rows that make up user turns: live, non-silent
/// `user` rows. `json_valid` guards `json_extract` against a malformed payload.
pub(crate) const USER_TURN_ROWS_SQL: &str = "superseded = 0
       AND kind = 'user'
       AND json_valid(payload)
       AND COALESCE(json_extract(payload, '$.silent'), 0) = 0";

impl TranscriptStore {
    /// Number of distinct user turns strictly before `seq`.
    pub fn user_turns_before(&self, seq: i64) -> rusqlite::Result<i64> {
        self.conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT {TURN_KEY_SQL}) FROM message
                 WHERE session_id = ?1 AND seq < ?2 AND {USER_TURN_ROWS_SQL}"
            ),
            params![self.session_id, seq],
            |r| r.get(0),
        )
    }

    /// [`Self::user_turns_before`] for page readers with no error channel: a
    /// failure is logged and reads as 0.
    pub(crate) fn user_turns_before_lossy(&self, seq: i64) -> i64 {
        self.user_turns_before(seq).unwrap_or_else(|e| {
            tracing::warn!(session_id = %self.session_id, seq, "user_turns_before failed: {e}");
            0
        })
    }

    /// Number of distinct user turns in the session.
    pub(crate) fn user_turn_count(&self) -> rusqlite::Result<i64> {
        self.user_turns_before(i64::MAX)
    }

    /// First seq of every user turn, ascending. A hit at `seq` is in user turn
    /// `starts.partition_point(|&s| s <= seq)` (1-based; 0 = before the first).
    pub(crate) fn user_turn_starts(&self) -> rusqlite::Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT MIN(seq) AS first_seq FROM message
             WHERE session_id = ?1 AND {USER_TURN_ROWS_SQL}
             GROUP BY {TURN_KEY_SQL} ORDER BY first_seq ASC"
        ))?;
        let result = stmt
            .query_map(params![self.session_id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    /// First seq of every window turn, ascending: each `turn_id` turn and each
    /// `user` row without one, plus the first live row when it precedes them
    /// (leading rows that no turn owns form one turn of their own).
    pub(crate) fn turn_starts(&self) -> rusqlite::Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT first_seq FROM (
               SELECT MIN(seq) AS first_seq FROM message
               WHERE session_id = ?1 AND {TURN_START_ROWS_SQL}
               GROUP BY {TURN_KEY_SQL}
               UNION
               SELECT MIN(seq) FROM message WHERE session_id = ?1 AND superseded = 0
             ) WHERE first_seq IS NOT NULL ORDER BY first_seq ASC"
        ))?;
        let result = stmt
            .query_map(params![self.session_id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    /// Turn-aligned window around `around_seq` within `max_bytes`.
    /// The turn containing `around_seq` is always returned whole.
    pub fn page_around(
        &self,
        around_seq: i64,
        n_turns: i64,
        max_bytes: usize,
    ) -> rusqlite::Result<AroundPage> {
        let n = (n_turns.max(1)) as usize;

        let starts = self.turn_starts()?;
        if starts.is_empty() {
            return Ok(AroundPage::default());
        }

        // Find which turn contains around_seq
        let center_idx = starts
            .partition_point(|&s| s <= around_seq)
            .saturating_sub(1);
        let (min_candidate_idx, max_candidate_idx, candidate_cut_seq, candidate_end_seq) =
            candidate_window(&starts, center_idx, n);

        // Query row byte sizes in candidate range
        let sizes: Vec<(i64, usize)> = self
            .conn
            .prepare(
                "SELECT seq, LENGTH(CAST(payload AS BLOB)) FROM message
                 WHERE session_id = ?1 AND superseded = 0 AND seq >= ?2 AND seq < ?3
                 ORDER BY seq ASC",
            )?
            .query_map(
                params![self.session_id, candidate_cut_seq, candidate_end_seq],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as usize)),
            )?
            .collect::<Result<Vec<_>, _>>()?;

        let (from_seq, to_seq) = pick_window(
            &starts,
            &sizes,
            center_idx,
            n,
            max_bytes,
            min_candidate_idx,
            max_candidate_idx,
        );

        let rows: Vec<(i64, String)> = self
            .conn
            .prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND superseded = 0 AND seq >= ?2 AND seq < ?3 ORDER BY seq ASC",
            )?
            .query_map(params![self.session_id, from_seq, to_seq], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let events: Vec<NormalizedEvent> = rows
            .iter()
            .filter_map(|(s, p)| self.parse_row(*s, p))
            .collect();

        let oldest_seq = events.first().and_then(|e| e.log_seq).or(Some(from_seq));
        let has_more = self.exists_before(from_seq);
        let turns_before = self.user_turns_before(from_seq)?;

        Ok(AroundPage {
            events,
            oldest_seq,
            has_more,
            turns_before,
        })
    }
}

fn turn_range_bounds(starts: &[i64], from_idx: usize, to_idx: usize) -> (i64, i64) {
    let from_seq = starts[from_idx];
    let to_seq = if to_idx + 1 < starts.len() {
        starts[to_idx + 1]
    } else {
        i64::MAX
    };
    (from_seq, to_seq)
}

fn candidate_window(starts: &[i64], center_idx: usize, n: usize) -> (usize, usize, i64, i64) {
    let max_older = (n - 1) / 2;
    let min_idx = center_idx.saturating_sub(max_older);
    let max_idx = (center_idx + n - 1).min(starts.len() - 1);
    let (cut_seq, end_seq) = turn_range_bounds(starts, min_idx, max_idx);
    (min_idx, max_idx, cut_seq, end_seq)
}

/// Pure helper to select the `[from_seq, to_seq)` window bounds based on turn counts and byte budget.
fn pick_window(
    starts: &[i64],
    sizes: &[(i64, usize)],
    center_idx: usize,
    n: usize,
    max_bytes: usize,
    min_candidate_idx: usize,
    max_candidate_idx: usize,
) -> (i64, i64) {
    let max_older = (n - 1) / 2;
    let num_candidates = max_candidate_idx - min_candidate_idx + 1;

    let mut turn_sizes = vec![0usize; num_candidates];
    for (seq, size) in sizes {
        let turn_rel = if *seq >= starts[max_candidate_idx] {
            num_candidates - 1
        } else {
            let abs_idx = starts.partition_point(|&s| s <= *seq).saturating_sub(1);
            abs_idx.saturating_sub(min_candidate_idx)
        };
        if turn_rel < turn_sizes.len() {
            turn_sizes[turn_rel] += size;
        }
    }

    let center_rel = center_idx - min_candidate_idx;
    let mut acc_bytes = turn_sizes[center_rel];
    let mut oldest_rel = center_rel;
    let mut newest_rel = center_rel;

    let mut older_wanted = max_older;
    let mut newer_wanted = n - 1 - older_wanted;

    let mut can_add_older = true;
    let mut can_add_newer = true;

    while (can_add_older && older_wanted > 0) || (can_add_newer && newer_wanted > 0) {
        if can_add_older && older_wanted > 0 {
            if oldest_rel > 0 {
                let next_older = oldest_rel - 1;
                let size = turn_sizes[next_older];
                if acc_bytes + size <= max_bytes {
                    acc_bytes += size;
                    oldest_rel = next_older;
                    older_wanted -= 1;
                } else {
                    can_add_older = false;
                }
            } else {
                can_add_older = false;
                newer_wanted += older_wanted;
                older_wanted = 0;
            }
        }

        if can_add_newer && newer_wanted > 0 {
            if newest_rel + 1 < num_candidates {
                let next_newer = newest_rel + 1;
                let size = turn_sizes[next_newer];
                if acc_bytes + size <= max_bytes {
                    acc_bytes += size;
                    newest_rel = next_newer;
                    newer_wanted -= 1;
                } else {
                    can_add_newer = false;
                }
            } else {
                can_add_newer = false;
            }
        }
    }

    let chosen_oldest_idx = min_candidate_idx + oldest_rel;
    let chosen_newest_idx = min_candidate_idx + newest_rel;

    turn_range_bounds(starts, chosen_oldest_idx, chosen_newest_idx)
}
