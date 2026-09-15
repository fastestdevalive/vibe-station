// Verifies that set_lifecycle_state is private to lifecycle.rs.
// If this file compiles, the two-axis enforcement is broken.
fn main() {
    let _ = vst_lifecycle::lifecycle::set_lifecycle_state;
}
