use spiral_rs::client::Client;
use spiral_rs::util::params_from_json;

const PARAMS_JSON: &str = r#"{"n":2,"nu_1":9,"nu_2":2,"p":256,"q2_bits":22,"t_gsw":7,"t_conv":4,"t_exp_left":5,"t_exp_right":56,"instances":3,"db_item_size":20480}"#;

fn query_item(client: &mut Client, uuid: &str, item: usize, base: &str) -> Vec<u8> {
    let q_bytes = client.generate_query(item).serialize();
    let mut payload = uuid.as_bytes().to_vec();
    payload.extend_from_slice(&q_bytes);
    std::fs::write("/tmp/_q_payload.bin", &payload).unwrap();
    let resp = std::process::Command::new("curl")
        .args(["-s", "-X", "POST", "-H", "Content-Type: application/octet-stream",
               "--data-binary", "@/tmp/_q_payload.bin", &format!("{}/api/private-read", base)])
        .output().unwrap();
    client.decode_response(&resp.stdout)
}

fn main() {
    let port = 8097u16;
    let base = format!("http://localhost:{}", port);
    let tile_size = 20480usize;

    let params_box = Box::new(params_from_json(PARAMS_JSON));
    let params_s: &'static _ = Box::leak(params_box);
    let mut client = Client::init(params_s);
    let setup = client.generate_keys();
    let setup_bytes = setup.serialize();

    // Upload setup
    let tmp = "/tmp/_q_setup.bin";
    std::fs::write(tmp, &setup_bytes).unwrap();
    let out = std::process::Command::new("curl")
        .args(["-s", "-X", "POST", "-H", "Content-Type: application/octet-stream",
               "--data-binary", &format!("@{}", tmp), &format!("{}/api/setup", base)])
        .output().unwrap();
    let uuid = String::from_utf8(out.stdout).unwrap().trim().to_string();
    println!("UUID: {}", uuid);

    // Query item 0 — expect all 0x42
    let dec0 = query_item(&mut client, &uuid, 0, &base);
    let ok0 = dec0[..tile_size].iter().all(|&b| b == 0x42);
    let wrong0: Vec<usize> = dec0[..tile_size].iter().enumerate()
        .filter(|(_, &b)| b != 0x42).map(|(i, _)| i).collect();
    println!("Item 0: correct={} first8={:?} wrong_positions({})={:?}",
        ok0, &dec0[..8], wrong0.len(), &wrong0[..wrong0.len().min(8)]);

    // Query item 1 — expect all 0x99
    let dec1 = query_item(&mut client, &uuid, 1, &base);
    let ok1 = dec1[..tile_size].iter().all(|&b| b == 0x99);
    let wrong1: Vec<usize> = dec1[..tile_size].iter().enumerate()
        .filter(|(_, &b)| b != 0x99).map(|(i, _)| i).collect();
    println!("Item 1: correct={} first8={:?} wrong_positions({})={:?}",
        ok1, &dec1[..8], wrong1.len(), &wrong1[..wrong1.len().min(8)]);

    if ok0 && ok1 {
        println!("PASS: GPU server decrypts correctly!");
    } else {
        println!("FAIL: decryption mismatch");
        std::process::exit(1);
    }
}
