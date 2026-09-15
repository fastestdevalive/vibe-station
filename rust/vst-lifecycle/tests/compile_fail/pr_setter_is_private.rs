// Verifies that set_pr_status is private to pr_poller.rs.
// If this file compiles, the two-axis enforcement is broken.
fn main() {
    let _ = vst_lifecycle::pr_poller::set_pr_status;
}
