//! Tauri 壳：**只做参数转发与错误映射**（设计 §三.3）。
//! 所有业务逻辑在 `qsdb-studio-core`，这里保持薄。

mod commands;

use std::sync::Arc;

use qsdb_studio_core::StudioCore;
use tauri::Manager;

/// 启动应用。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 档案/历史/流式 spool 都落在 app-data 目录（不碰用户文档目录）。
            let dir = app.path().app_data_dir()?;
            let core = StudioCore::open(&dir)?;
            app.manage(Arc::new(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profiles_list,
            commands::profile_save,
            commands::profile_delete,
            commands::conn_test,
            commands::conn_create,
            commands::conn_login,
            commands::conn_health,
            commands::conn_session,
            commands::conn_close,
            commands::meta_databases,
            commands::meta_tables,
            commands::meta_partitions,
            commands::meta_use,
            commands::sql_execute,
            commands::sql_split,
            commands::sql_cancel,
            commands::sql_stream_start,
            commands::sql_stream_page,
            commands::sql_stream_stop,
            commands::sql_stream_release,
            commands::sql_stream_export_csv,
            commands::save_text_file,
            commands::read_text_file,
            commands::history_list,
            commands::favorites_list,
            commands::favorite_add,
            commands::favorite_rename,
            commands::favorite_remove,
            commands::read_image_data_url,
            // M2 管理面（qsdb-client 一等方法）
            commands::config_get,
            commands::config_put,
            commands::sessions_list,
            commands::sessions_kick,
            commands::queries_list,
            commands::watch_start,
            commands::watch_stop,
            commands::grants_put,
            // M2.6 / M2.7
            commands::copy_build_sql,
            commands::copy_to,
            commands::download_file,
            commands::files_list,
            commands::files_detail,
            commands::files_trash,
            commands::csv_preview,
            commands::csv_read_row,
            commands::import_csv,
        ])
        .run(tauri::generate_context!())
        .expect("QSDB Studio 启动失败");
}
