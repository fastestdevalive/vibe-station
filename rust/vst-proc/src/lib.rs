#![deny(unsafe_code)]

//! vst-proc — tmux/PTY/subprocess spawning behind a `PtyBackend` trait.
//! This crate is the documented PTY/FFI boundary: it uses `#![deny(unsafe_code)]`
//! (not `forbid`) so a later part may add a documented, SAFETY-commented `unsafe`
//! block at the PTY syscall boundary. See daemon-rust-port arch doc Gotcha "vst-proc".
