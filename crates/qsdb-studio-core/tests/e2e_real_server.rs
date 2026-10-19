//! 真 server e2e（env 门控，设计 §八）：
//!
//! ```text
//! QSDB_STUDIO_E2E_SERVER=http://127.0.0.1:9430 cargo test -p qsdb-studio-core --test e2e_real_server
//! ```
//!
//! 未设置环境变量时**直接返回**（不算失败）。要求目标实例允许匿名连接；
//! 测试不依赖已有表，用派生表交叉连接自己造行。

use std::sync::mpsc;
use std::time::Duration;

use qsdb_studio_core::{
    CopyFormat, CopyInput, MemorySecretStore, ParamInput, ProfileAuth, ProfileInput,
    QueryOptionsInput, StreamEvent, StudioCore,
};
use serde_json::json;
use std::sync::Arc;

/// token 鉴权 server 的附加门控；未设置时按匿名实例测。
fn e2e_token() -> Option<String> {
    std::env::var("QSDB_STUDIO_E2E_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
}

fn core(url: &str) -> (tempfile::TempDir, StudioCore) {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let core = StudioCore::open_with_secrets(tmp.path(), Arc::new(MemorySecretStore::default()))
        .expect("core open");
    let token = e2e_token();
    let auth = if token.is_some() {
        ProfileAuth::Bearer
    } else {
        ProfileAuth::None
    };
    core.save_profile(ProfileInput {
        id: None,
        name: "e2e".into(),
        url: url.into(),
        auth,
        default_database: None,
        read_only: false,
        secret: token,
    })
    .expect("save profile");
    (tmp, core)
}

#[test]
fn real_server_smoke() {
    let Ok(url) = std::env::var("QSDB_STUDIO_E2E_SERVER") else {
        eprintln!("跳过：未设置 QSDB_STUDIO_E2E_SERVER");
        return;
    };
    let (_tmp, core) = core(&url);
    let profile_id = core.list_profiles().unwrap()[0].id.clone();

    let conn = core.connect(&profile_id).expect("connect");
    assert!(!conn.version.is_empty(), "health 版本为空");
    assert!(core.meta_databases(&profile_id).is_ok());
    assert!(core.meta_tables(&profile_id).is_ok());

    // 表单“测试连接”：匿名/Bearer 成功；错误 Token 与不可达地址明确失败。
    let probe = if let Some(token) = e2e_token() {
        let ok = core
            .test_connection(&ProfileInput {
                id: None,
                name: "probe".into(),
                url: url.clone(),
                auth: ProfileAuth::Bearer,
                default_database: None,
                read_only: false,
                secret: Some(token),
            })
            .expect("test bearer connection");
        let bad = core
            .test_connection(&ProfileInput {
                id: None,
                name: "probe".into(),
                url: url.clone(),
                auth: ProfileAuth::Bearer,
                default_database: None,
                read_only: false,
                secret: Some("definitely-wrong".into()),
            })
            .unwrap_err();
        assert_eq!(bad.status, Some(401), "错误 Token 应报 401: {bad:?}");
        ok
    } else {
        core.test_connection(&ProfileInput {
            id: None,
            name: "probe".into(),
            url: url.clone(),
            auth: ProfileAuth::None,
            default_database: None,
            read_only: false,
            secret: None,
        })
        .expect("test anonymous connection")
    };
    assert!(!probe.version.is_empty());
    assert!(probe.user.is_none());
    let bad = core
        .test_connection(&ProfileInput {
            id: None,
            name: "probe".into(),
            url: "http://127.0.0.1:1".into(),
            auth: ProfileAuth::None,
            default_database: None,
            read_only: false,
            secret: None,
        })
        .unwrap_err();
    assert!(
        matches!(bad.kind.as_str(), "io" | "http"),
        "不可达地址应报传输错误，实际={bad:?}"
    );

    // 小结果 + 参数化
    let r = core
        .execute(&profile_id, "SELECT 1 AS x", &QueryOptionsInput::default())
        .expect("select 1");
    assert_eq!(r.kind, "rows");
    assert_eq!(r.row_count, 1);
    assert_eq!(r.rows[0][0], json!(1));

    let opts = QueryOptionsInput {
        params: vec![ParamInput {
            value: json!(7),
            ty: Some("BIGINT".into()),
        }],
        ..Default::default()
    };
    let r = core
        .execute(&profile_id, "SELECT $1 AS x", &opts)
        .expect("param query");
    assert_eq!(r.rows[0][0], json!(7));

    // 错误按 code 分档（不解析文案）
    let err = core
        .execute(
            &profile_id,
            "SELECT * FROM definitely_not_a_table",
            &QueryOptionsInput::default(),
        )
        .expect_err("table should not exist");
    assert_eq!(err.code.as_deref(), Some("TABLE_NOT_FOUND"));

    // 流式：9 路 4 行派生表交叉连接 = 262,144 行（不依赖库内已有表）
    let d = "(SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)";
    let from = (0..9)
        .map(|i| format!("{d} t{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT t0.x AS v FROM {from}");

    let (tx, rx) = mpsc::channel::<StreamEvent>();
    let stream_id = core
        .start_stream(&profile_id, sql, &QueryOptionsInput::default(), move |ev| {
            let _ = tx.send(ev);
        })
        .expect("start stream");

    let mut chunks = 0usize;
    let mut ended = None;
    while let Ok(ev) = rx.recv_timeout(Duration::from_secs(120)) {
        match ev {
            StreamEvent::Chunk { .. } => chunks += 1,
            StreamEvent::End { total_rows, .. } => {
                ended = Some(total_rows);
                break;
            }
            StreamEvent::Error { error, .. } => panic!("stream error: {error}"),
            StreamEvent::Started { .. } => {}
        }
    }
    let total = ended.expect("stream did not end");
    assert_eq!(total, 262_144);
    assert!(chunks > 0);

    let page = core.stream_page(&stream_id, 0, 10).expect("page 0");
    assert_eq!(page.rows.len(), 10);
    assert_eq!(page.total_rows, 262_144);
    assert!(page.done);

    // 流式导出（完整、UTF-8 BOM）
    let out = _tmp.path().join("stream.csv");
    let n = core
        .stream_export_csv(&stream_id, &out, true)
        .expect("export csv");
    assert_eq!(n, 262_144);
    let bytes = std::fs::read(&out).unwrap();
    assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    let lines = bytes.iter().filter(|b| **b == b'\n').count();
    assert_eq!(lines, 262_145, "表头 + 全部行");

    core.stream_release(&stream_id).expect("release");
    assert!(core.stream_page(&stream_id, 0, 1).is_err());

    // ---- M2.7 CSV 导入：新 bulk 类型（DECIMAL/FLOAT/TIME/BINARY/I8/I16）----
    let table = format!("studio_import_{}", std::process::id());
    let create = format!(
        "CREATE TABLE {table} (id BIGINT, amount DOUBLE, name VARCHAR, ok BOOLEAN, d DATE, \
         ts TIMESTAMP, dec DECIMAL(10,2), f FLOAT, t TIME, b BLOB, i8 TINYINT, i16 SMALLINT)"
    );
    core.execute(&profile_id, &create, &QueryOptionsInput::default())
        .expect("create import table");

    let csv_path = _tmp.path().join("import.csv");
    std::fs::write(
        &csv_path,
        "id,amount,name,ok,d,ts,dec,f,t,b,i8,i16\n\
         1,10.5,alpha,true,2026-01-01,2026-01-01T00:00:00Z,30.80,0.1,12:34:56.789,00abff,7,300\n\
         2,,中文,false,2026-01-02,2026-01-02 00:00:00,-0.05,2.5,00:00:01.5,,-8,-300\n",
    )
    .expect("write csv");

    let mut last_rows = 0u64;
    let summary = core
        .import_csv(&profile_id, &table, &csv_path, &[], |p| last_rows = p.rows)
        .expect("import csv");
    assert_eq!(summary.rows, 2);
    assert_eq!(summary.batches, 1);
    assert_eq!(last_rows, 2);

    let q = format!(
        "SELECT id, amount, name, ok, d, ts, dec, f, t, b, i8, i16 FROM {table} ORDER BY id"
    );
    let r = core
        .execute(&profile_id, &q, &QueryOptionsInput::default())
        .expect("read imported");
    assert_eq!(r.row_count, 2);
    let row0 = &r.rows[0];
    assert_eq!(row0[0], json!(1));
    assert_eq!(row0[1], json!(10.5));
    assert_eq!(row0[2], json!("alpha"));
    assert_eq!(row0[3], json!(true));
    assert_eq!(row0[4], json!("2026-01-01"));
    assert_eq!(row0[5], json!("2026-01-01T00:00:00Z"));
    assert_eq!(row0[6], json!("30.80"), "DECIMAL 保留 scale");
    assert_eq!(row0[7], json!(0.1), "F32 最短表示");
    assert_eq!(row0[8], json!("12:34:56.789"));
    assert_eq!(row0[9], json!("00abff"));
    assert_eq!(row0[10], json!(7));
    assert_eq!(row0[11], json!(300));
    let row1 = &r.rows[1];
    assert_eq!(row1[1], serde_json::Value::Null);
    assert_eq!(row1[2], json!("中文"));
    assert_eq!(row1[3], json!(false));
    assert_eq!(row1[6], json!("-0.05"));
    assert_eq!(row1[7], json!(2.5));
    assert_eq!(row1[8], json!("00:00:01.5"));
    assert_eq!(row1[9], serde_json::Value::Null);
    assert_eq!(row1[10], json!(-8));
    assert_eq!(row1[11], json!(-300));

    // ---- M2.6 COPY 导出 ----
    // (a) 绝对目标：COPY 与 read_parquet 都用同一个绝对路径，读回闭环。
    let abs_target = _tmp
        .path()
        .join(format!("abs-export-{}", std::process::id()));
    let abs_copy = core
        .copy_to(
            &profile_id,
            &CopyInput {
                query: format!("SELECT * FROM {table}"),
                target: abs_target.to_string_lossy().into_owned(),
                format: CopyFormat::Parquet,
                partition_by: vec![],
                header: true,
            },
        )
        .expect("copy export to absolute target");
    assert_eq!(abs_copy.rows_affected, Some(2));
    assert_eq!(abs_copy.command.as_deref(), Some("COPY"));
    let verify = core
        .execute(
            &profile_id,
            &abs_copy.verify_sql,
            &QueryOptionsInput::default(),
        )
        .expect("read back parquet via absolute path");
    assert_eq!(verify.row_count, 2);

    // (b) 相对目标：落点按执行库根解析，经 /files 下载验证（不依赖服务端 CWD）。
    let target = format!("exports/studio-e2e-{}", std::process::id());
    let copy = core
        .copy_to(
            &profile_id,
            &CopyInput {
                query: format!("SELECT * FROM {table}"),
                target: target.clone(),
                format: CopyFormat::Parquet,
                partition_by: vec![],
                header: true,
            },
        )
        .expect("copy export to relative target");
    assert_eq!(copy.rows_affected, Some(2));
    assert!(
        copy.message
            .as_deref()
            .is_some_and(|m| m.contains("exported 2 rows")),
        "回执: {:?}",
        copy.message
    );

    let local = _tmp.path().join("part-00000.parquet");
    let n = core
        .download_file(&profile_id, &format!("{target}/part-00000.parquet"), &local)
        .expect("download part via /files");
    assert!(n > 0);
    let part = std::fs::read(&local).expect("read downloaded part");
    assert!(part.starts_with(b"PAR1"), "应为 parquet 文件");

    core.execute(
        &profile_id,
        &format!("DROP TABLE {table}"),
        &QueryOptionsInput::default(),
    )
    .expect("drop import table");

    core.close(&profile_id);
}

/// 多挂载 COPY//files（内核十九批Ⅵ）：相对目标按执行库根、下载加挂载前缀、
/// 读回在同一个执行库。门控：`QSDB_STUDIO_E2E_MULTI_MOUNT=1`，且目标 server
/// 必须带 `--mount settle=<目录>`。
#[test]
fn real_server_multi_mount_copy() {
    let Ok(url) = std::env::var("QSDB_STUDIO_E2E_SERVER") else {
        eprintln!("跳过：未设置 QSDB_STUDIO_E2E_SERVER");
        return;
    };
    if std::env::var("QSDB_STUDIO_E2E_MULTI_MOUNT").as_deref() != Ok("1") {
        eprintln!("跳过：未设置 QSDB_STUDIO_E2E_MULTI_MOUNT=1");
        return;
    }
    let (_tmp, core) = core(&url);
    let profile_id = core.list_profiles().unwrap()[0].id.clone();
    core.connect(&profile_id).expect("connect");
    let q = |sql: &str| core.execute(&profile_id, sql, &QueryOptionsInput::default());

    let table = format!("copy_probe_{}", std::process::id());
    q(&format!("CREATE TABLE settle.{table} (a BIGINT, s STRING)")).expect("create");
    q(&format!(
        "INSERT INTO settle.{table} VALUES (1,'x'),(2,'y')"
    ))
    .expect("insert");

    // CSV 不创建父目录：目标直接放在库根（内核契约测试同形态）。
    let target = format!("{table}.csv");
    let copy = core
        .copy_to(
            &profile_id,
            &CopyInput {
                query: format!("SELECT * FROM settle.{table}"),
                target: target.clone(),
                format: CopyFormat::Csv,
                partition_by: vec![],
                header: true,
            },
        )
        .expect("copy to settle root");
    assert_eq!(copy.rows_affected, Some(2));

    // 相对目标的 SQL 读回取决于服务端 CWD（read_parquet 的相对路径语义），
    // 这里不做断言；用 /files 下载验证落点正确。

    // 下载：<挂载名>/<相对路径>
    let local = _tmp.path().join("settle-export.csv");
    let n = core
        .download_file(&profile_id, &format!("settle/{target}"), &local)
        .expect("download with mount prefix");
    assert!(n > 0);
    let text = std::fs::read_to_string(&local).expect("read downloaded csv");
    assert!(text.contains('x') && text.contains('y'), "内容: {text}");

    // 裸路径落在 default 库根 → 404（证明前缀真的路由了）
    let bare = _tmp.path().join("bare.csv");
    let err = core.download_file(&profile_id, &target, &bare).unwrap_err();
    assert_eq!(err.status, Some(404), "{err:?}");

    q(&format!("DROP TABLE settle.{table}")).expect("drop");
    core.close(&profile_id);
}
