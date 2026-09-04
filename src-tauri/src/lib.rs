mod ai_runner;
mod avatars;
mod config;
mod external;
mod git_runner;
mod rebase_state;
mod updater;
mod watcher;
mod worktree;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // First thing, before any window is shown: the previous version's
            // executable is still on disk next to this one, renamed out of the
            // way by the update that installed this build. It is unlocked now
            // and it will never be unlocked at a better moment.
            updater::sweep_after_update();

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            git_runner::git_run,
            config::config_read,
            config::config_write,
            config::config_dir_path,
            avatars::avatar_read,
            avatars::avatar_write,
            watcher::watch_repo,
            watcher::unwatch_repo,
            external::open_external,
            external::reveal_folder,
            external::reveal_path,
            worktree::worktree_read,
            worktree::worktree_write,
            worktree::worktree_delete,
            worktree::worktree_restore_blob,
            rebase_state::rebase_state,
            updater::update_install_kind,
            updater::update_portable_apply,
            ai_runner::ai_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
