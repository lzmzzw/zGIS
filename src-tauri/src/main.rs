#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if let Some(code) = zgis_lib::gdb_worker_entry() {
        std::process::exit(code);
    }
    zgis_lib::run();
}
