use std::io::Cursor;
use spiral_rs::client::{Client, PublicParameters, Query};
use spiral_rs::server::{load_db_from_seek, process_query};
use spiral_rs::util::params_from_json;

fn test_pir(label: &str, params_json: &str) {
    println!("--- {label} ---");
    let params = params_from_json(params_json);
    let tile_size = 20480usize;
    let num_items = params.num_items();
    let mut raw_db = vec![0u8; num_items * tile_size];
    for i in 0..tile_size { raw_db[i] = 0x42; }
    for i in 0..tile_size { raw_db[tile_size + i] = 0x99; }
    let mut cursor = Cursor::new(&raw_db[..]);
    let db = load_db_from_seek(&params, &mut cursor);
    let params_box = Box::new(params_from_json(params_json));
    let params_s: &'static _ = Box::leak(params_box);
    let mut client = Client::init(params_s);
    let pub_params = client.generate_keys();
    let pp = PublicParameters::deserialize(params_s, &pub_params.serialize());
    let q = Query::deserialize(params_s, &client.generate_query(0).serialize());
    let decoded = client.decode_response(&process_query(params_s, &pp, &q, db.as_slice()));
    let ok0 = decoded[0..tile_size].iter().all(|&b| b == 0x42);
    let q1 = Query::deserialize(params_s, &client.generate_query(1).serialize());
    let decoded1 = client.decode_response(&process_query(params_s, &pp, &q1, db.as_slice()));
    let ok1 = decoded1[0..tile_size].iter().all(|&b| b == 0x99);
    println!("  item0 correct={ok0}, item1 correct={ok1}  [0..4]={:?}", &decoded[0..4]);
    assert!(ok0, "item0 decryption failed");
    assert!(ok1, "item1 decryption failed");
}

fn main() {
    // Production params: t_conv=4 and t_exp_right=56 are required for correct
    // decryption. The Blyss v1 values (t_conv=3, t_exp_right=5, version=1)
    // produce too much noise and cause decryption failures.
    test_pir(
        "production params (nu_2=4, instances=3)",
        r#"{"n":2,"nu_1":9,"nu_2":4,"p":256,"q2_bits":22,"t_gsw":7,"t_conv":4,"t_exp_left":5,"t_exp_right":56,"instances":3,"db_item_size":20480}"#,
    );
}
