//! Budgeted driver for store backfills (the search index, the turn outline).

use std::time::{Duration, Instant};

/// Runs `step` until it reports done or `budget` is spent, calling `between`
/// after every step that another one follows. The first error stops the run.
pub(super) fn backfill_within<E>(
    budget: Duration,
    mut step: impl FnMut() -> Result<bool, E>,
    mut between: impl FnMut(),
) -> Result<(), E> {
    let start = Instant::now();
    loop {
        let done = step()?;
        if done || start.elapsed() >= budget {
            break;
        }
        between();
        // A real pause, not `yield_now`: `std::sync::Mutex` is not fair, so the
        // search thread could otherwise re-take the lock before a woken appender runs.
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_budget_runs_exactly_one_step() {
        let mut steps = 0;
        backfill_within::<()>(
            Duration::ZERO,
            || {
                steps += 1;
                Ok(false)
            },
            || {},
        )
        .unwrap();
        assert_eq!(steps, 1);
    }

    #[test]
    fn unbounded_budget_steps_until_done() {
        let mut steps = 0;
        let mut betweens = 0;
        backfill_within::<()>(
            Duration::MAX,
            || {
                steps += 1;
                Ok(steps == 4)
            },
            || betweens += 1,
        )
        .unwrap();
        assert_eq!(steps, 4);
        assert_eq!(betweens, 3);
    }

    #[test]
    fn step_error_stops_and_propagates() {
        let mut steps = 0;
        let res = backfill_within(
            Duration::MAX,
            || {
                steps += 1;
                Err("broken")
            },
            || {},
        );
        assert_eq!(res, Err("broken"));
        assert_eq!(steps, 1);
    }
}
