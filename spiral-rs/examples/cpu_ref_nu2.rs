// CPU reference test for nu_2=2, 2048 tiles, items 0 and 1
// Run from sdk/lib/spiral-rs with: cargo script or copy into examples/

use std::io::Cursor;
use spiral_rs::client::{Client, PublicParameters, Query};
use spiral_rs::server::{load_db_from_seek, process_query};
use spiral_rs::util::params_from_json;

fn main() {
    let params_json = r#"{"n":2,"nu_1":9,"nu_2":2,"p":256,"q2_bits":22,"t_gsw":7,"t_conv":4,"t_exp_left":5,"t_exp_right":56,"instances":3,"db_item_size":20480}"#;
    let params = params_from_json(params_json);
    println!("params: nu_1={} nu_2={} dim0={} num_per={} instances={} total_items={}",
        params.db_dim_1, params.db_dim_2,
        1<<params.db_dim_1, 1<<params.db_dim_2,
        params.instances, params.num_items());

    let tile_size = 20480usize;
    let num_items = params.num_items();
    let mut raw_db = vec![0u8; num_items * tile_size];
    // Item 0: all 0x42
    for i in 0..tile_size { raw_db[i] = 0x42; }
    // Item 1: all 0x99
    for i in 0..tile_size { raw_db[tile_size + i] = 0x99; }

    let mut cursor = Cursor::new(&raw_db[..]);
    let db = load_db_from_seek(&params, &mut cursor);

    let params_box = Box::new(params_from_json(params_json));
    let params_s: &'static _ = Box::leak(params_box);
    let mut client = Client::init(params_s);
    let pub_params = client.generate_keys();
    let pp = PublicParameters::deserialize(params_s, &pub_params.serialize());

    // Test item 0
    let q0 = Query::deserialize(params_s, &client.generate_query(0).serialize());
    let resp0 = process_query(params_s, &pp, &q0, db.as_slice());
    let decoded0 = client.decode_response(&resp0);
    let ok0 = decoded0[..tile_size].iter().all(|&b| b == 0x42);
    let wrong0: Vec<usize> = decoded0[..tile_size].iter().enumerate()
        .filter(|(_, &b)| b != 0x42).map(|(i, _)| i).collect();
    println!("Item 0: correct={ok0} wrong_count={} first8={:?}",
        wrong0.len(), &decoded0[..8]);

    // Test item 1
    let q1 = Query::deserialize(params_s, &client.generate_query(1).serialize());
    let resp1 = process_query(params_s, &pp, &q1, db.as_slice());
    let decoded1 = client.decode_response(&resp1);
    let ok1 = decoded1[..tile_size].iter().all(|&b| b == 0x99);
    let wrong1: Vec<usize> = decoded1[..tile_size].iter().enumerate()
        .filter(|(_, &b)| b != 0x99).map(|(i, _)| i).collect();
    println!("Item 1: correct={ok1} wrong_count={} first8={:?}",
        wrong1.len(), &decoded1[..8]);
}
