mod config;
mod external;
mod git_runner;
mod watcher;
mod worktree;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            git_runner::git_run,
            config::config_read,
            config::config_write,
            config::config_dir_path,
            watcher::watch_repo,
            watcher::unwatch_repo,
            external::open_external,
            external::reveal_folder,
            worktree::worktree_read,
            worktree::worktree_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
