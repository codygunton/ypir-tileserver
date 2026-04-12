/// Correctness test: compares spiral-gpu server output against the spiral-rs
/// CPU reference implementation for a known synthetic database.
///
/// Database: item 0 = all 0x42, item 1 = all 0x99, rest = 0x00.
/// Test: query item 0 and item 1; both servers must return correct plaintext.
use std::io::Cursor;
use spiral_rs::client::Client;
use spiral_rs::server::{load_db_from_seek, process_query};
use spiral_rs::util::params_from_json;

const PARAMS_JSON: &str = r#"{"n":2,"nu_1":9,"nu_2":4,"p":256,"q2_bits":22,"t_gsw":7,"t_conv":4,"t_exp_left":5,"t_exp_right":56,"instances":3,"db_item_size":20480}"#;
const TILE_SIZE: usize = 20480;

fn http_post(url: &str, body: &[u8]) -> Vec<u8> {
    let tmp = "/tmp/_spiral_post_body.bin";
    std::fs::write(tmp, body).expect("write tmp");
    let out = std::process::Command::new("curl")
        .args(["-s", "-X", "POST",
               "-H", "Content-Type: application/octet-stream",
               "--data-binary", &format!("@{}", tmp), url])
        .output().expect("curl");
    out.stdout
}

fn http_get(url: &str) -> String {
    let out = std::process::Command::new("curl").args(["-s", url]).output().expect("curl");
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn build_synthetic_db(num_items: usize) -> Vec<u8> {
    let mut db = vec![0u8; num_items * TILE_SIZE];
    // Item 0: all 0x42
    for b in &mut db[0..TILE_SIZE] { *b = 0x42; }
    // Item 1: all 0x99
    for b in &mut db[TILE_SIZE..2*TILE_SIZE] { *b = 0x99; }
    db
}

fn main() {
    let port = 8094u16;
    let db_file = "/tmp/_spiral_test_db.bin";

    let params = params_from_json(PARAMS_JSON);
    let num_items = params.num_items();
    println!("params: {} items, {} setup bytes, {} query bytes",
             num_items, params.setup_bytes(), params.query_bytes());

    // Build and write synthetic database
    let raw_db = build_synthetic_db(num_items);
    std::fs::write(db_file, &raw_db).expect("write db");

    // Create a trivial tile_mapping.json
    let mapping_json = format!(
        r#"{{"num_tiles":{},"tile_size":{},"tiles":{{}}}}"#, num_items, TILE_SIZE
    );
    std::fs::write("/tmp/_spiral_tile_mapping.json", mapping_json).expect("write mapping");

    // ── CPU reference ────────────────────────────────────────────────────────
    let params_box = Box::new(params_from_json(PARAMS_JSON));
    let params_s: &'static _ = Box::leak(params_box);
    let mut client = Client::init(params_s);
    let setup = client.generate_keys();

    let mut cursor = Cursor::new(&raw_db[..]);
    let db = load_db_from_seek(params_s, &mut cursor);

    let pp_cpu = spiral_rs::client::PublicParameters::deserialize(
        params_s, &setup.serialize());

    // Generate query bytes ONCE so CPU and GPU use the same ciphertext
    let query_bytes: Vec<Vec<u8>> = [0usize, 1].iter()
        .map(|&idx| client.generate_query(idx).serialize())
        .collect();

    for (i, &idx) in [0usize, 1].iter().enumerate() {
        let q = spiral_rs::client::Query::deserialize(params_s, &query_bytes[i]);
        let resp_cpu = process_query(params_s, &pp_cpu, &q, db.as_slice());
        let decoded_cpu = client.decode_response(&resp_cpu);
        let expected = if idx == 0 { 0x42u8 } else { 0x99u8 };
        let ok = decoded_cpu[0..TILE_SIZE].iter().all(|&b| b == expected);
        println!("[CPU ref] item {}: first byte={:#04x}, all_correct={}", idx, decoded_cpu[0], ok);
        assert!(ok, "CPU reference failed for item {}", idx);
    }
    println!("CPU reference: PASS\n");

    // ── GPU server ───────────────────────────────────────────────────────────
    let server_bin = "/home/cody/fhe.rs/spiral-gpu/build/server/spiral_gpu_server";
    println!("Starting spiral-gpu server on port {}...", port);
    let mut server = std::process::Command::new(server_bin)
        .args(["--database", db_file,
               "--tile-mapping", "/tmp/_spiral_tile_mapping.json",
               "--num-tiles", &num_items.to_string(),
               "--tile-size", &TILE_SIZE.to_string(),
               "--port", &port.to_string()])
        .spawn()
        .expect("spawn server");

    // Wait until ready
    let base = format!("http://localhost:{}", port);
    let mut ready = false;
    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            ready = true;
            break;
        }
        eprint!(".");
    }
    if !ready { server.kill().ok(); panic!("Server didn't start"); }
    eprintln!("\nServer ready!");

    // Upload same keys
    let setup_bytes = setup.serialize();
    let uuid_bytes = http_post(&format!("{}/api/setup", base), &setup_bytes);
    let uuid = String::from_utf8(uuid_bytes).expect("uuid").trim().to_string();
    println!("Session UUID: {}", uuid);
    assert_eq!(uuid.len(), 36, "Bad UUID: {}", uuid);

    // Test items — reuse same query_bytes as CPU reference
    for (i, &idx) in [0usize, 1].iter().enumerate() {
        let q_bytes = &query_bytes[i];
        let mut payload = uuid.as_bytes().to_vec();
        payload.extend_from_slice(&q_bytes);

        let t0 = std::time::Instant::now();
        let raw_resp = http_post(&format!("{}/api/private-read", base), &payload);
        let ms = t0.elapsed().as_millis();

        let decoded_gpu = client.decode_response(&raw_resp);
        let expected = if idx == 0 { 0x42u8 } else { 0x99u8 };
        let ok = decoded_gpu[0..TILE_SIZE].iter().all(|&b| b == expected);
        let first_nonzero = decoded_gpu.iter().enumerate().find(|(_, &b)| b != 0)
            .map(|(i, &b)| format!("{}@{}", b, i)).unwrap_or("none".to_string());
        println!("[GPU] item {}: {}ms, first_nonzero={}, all_correct={}",
                 idx, ms, first_nonzero, ok);
        if !ok {
            println!("  First 16 decoded bytes: {:?}", &decoded_gpu[..16]);
            println!("  Response size: {} bytes", raw_resp.len());
        }
    }

    server.kill().ok();
    println!("\nDone.");
}
