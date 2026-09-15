//! Serde helpers for byte-identical JSON.
//!
//! `compact_f64`: serializes a whole `f64` as a JSON integer (`1`, not `1.0`)
//! to match how the Node daemon's `JSON.stringify` emits fractional display
//! ranks (`sortOrder`), which are `1` for integer ranks and `1.5` for
//! in-between ranks.

use serde::{Deserializer, Serializer};

/// `#[serde(with = "crate::serde_ext::compact_f64")]` on a `f64` field.
pub mod compact_f64 {
    use super::{Deserializer, Serializer};
    use serde::de::Visitor;

    /// Serialize a whole float as an integer (JSON `1`, not `1.0`).
    pub fn serialize<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let formatted = format!("{value}");
        if formatted.contains(['.', 'e', 'E']) {
            serializer.serialize_f64(*value)
        } else {
            serializer.serialize_i64(*value as i64)
        }
    }

    /// Deserialize from either an integer or a float JSON number.
    pub fn deserialize<'de, D>(deserializer: D) -> Result<f64, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct F64Visitor;

        impl Visitor<'_> for F64Visitor {
            type Value = f64;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON number")
            }

            fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
                Ok(v as f64)
            }

            fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
                Ok(v as f64)
            }

            fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E> {
                Ok(v)
            }
        }

        deserializer.deserialize_any(F64Visitor)
    }
}

/// `#[serde(with = "crate::serde_ext::compact_f64_opt")]` (combined with
/// `#[serde(skip_serializing_if = "Option::is_none")]`) on an `Option<f64>`
/// field. Serializes `None` as JSON `null` and `Some(1.0)` as `1`.
pub mod compact_f64_opt {
    use super::{compact_f64, Deserializer, Serializer};
    use serde::de::Visitor;

    /// Serialize an optional float: `None` → `null`, `Some(v)` → compact.
    pub fn serialize<S>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(v) => compact_f64::serialize(v, serializer),
            None => serializer.serialize_none(),
        }
    }

    /// Deserialize an optional float from `null` or a JSON number.
    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct OptVisitor;

        impl<'de> Visitor<'de> for OptVisitor {
            type Value = Option<f64>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON number or null")
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(None)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(None)
            }

            fn visit_some<D2>(self, d2: D2) -> Result<Self::Value, D2::Error>
            where
                D2: Deserializer<'de>,
            {
                compact_f64::deserialize(d2).map(Some)
            }
        }

        deserializer.deserialize_option(OptVisitor)
    }
}
