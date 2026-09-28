use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub hard_ok: bool,
    pub ok: bool,
    pub host_os: String,
    pub hostname: String,
    pub checked_at: String,
    pub checks: Vec<DoctorCheckDto>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheckDto {
    pub name: String,
    pub status: DoctorCheckStatus,
    pub required: bool,
    pub group: CheckGroup,
    pub message: String,
    pub resolved_path: Option<String>,
    pub install_hint: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorCheckStatus {
    Ok,
    Warn,
    Error,
    Timeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckGroup {
    Required,
    AgentCli,
    Optional,
    Diagnostic,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_report_with_all_status_and_group_variants() {
        let report = DoctorReport {
            hard_ok: true,
            ok: false,
            host_os: "linux".to_string(),
            hostname: "test-host".to_string(),
            checked_at: "2026-01-01T00:00:00Z".to_string(),
            checks: vec![
                DoctorCheckDto {
                    name: "ok-required".to_string(),
                    status: DoctorCheckStatus::Ok,
                    required: true,
                    group: CheckGroup::Required,
                    message: "all good".to_string(),
                    resolved_path: Some("/usr/bin/tmux".to_string()),
                    install_hint: None,
                },
                DoctorCheckDto {
                    name: "warn-agent-cli".to_string(),
                    status: DoctorCheckStatus::Warn,
                    required: false,
                    group: CheckGroup::AgentCli,
                    message: "optional CLI missing".to_string(),
                    resolved_path: None,
                    install_hint: Some("curl -fsSL https://bun.sh/install | bash".to_string()),
                },
                DoctorCheckDto {
                    name: "error-optional".to_string(),
                    status: DoctorCheckStatus::Error,
                    required: false,
                    group: CheckGroup::Optional,
                    message: "something failed".to_string(),
                    resolved_path: None,
                    install_hint: None,
                },
                DoctorCheckDto {
                    name: "timeout-diagnostic".to_string(),
                    status: DoctorCheckStatus::Timeout,
                    required: false,
                    group: CheckGroup::Diagnostic,
                    message: "timed out".to_string(),
                    resolved_path: None,
                    install_hint: None,
                },
            ],
        };

        let value = serde_json::to_value(&report).expect("serialize report");
        let back: DoctorReport =
            serde_json::from_value(value).expect("deserialize report");
        assert_eq!(report, back);
    }
}
