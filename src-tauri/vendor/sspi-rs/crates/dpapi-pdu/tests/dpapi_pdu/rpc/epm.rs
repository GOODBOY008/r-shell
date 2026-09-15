use dpapi_pdu::rpc::{
    EntryHandle, EptMap, EptMapResult, Floor, IpFloor, RpcConnectionOrientedFloor, TcpFloor, UuidFloor,
};
use uuid::uuid;

test_encoding_decoding! {
    ept_map,
    EptMap,
    EptMap {
        obj: None,
        tower: vec![
            Floor::Uuid(UuidFloor {
                uuid: uuid!("b9785960-524f-11df-8b6d-83dcded72085"),
                version: 1,
                version_minor: 0,
            }),
            Floor::Uuid(UuidFloor {
                uuid: uuid!("8a885d04-1ceb-11c9-9fe8-08002b104860"),
                version: 2,
                version_minor: 0,
            }),
            Floor::RpcConnectionOriented(RpcConnectionOrientedFloor {
                version_minor: 0,
            }),
            Floor::Tcp(TcpFloor {
                port: 135,
            }),
            Floor::Ip(IpFloor {
                addr: 0,
            }),
        ],
        entry_handle: EntryHandle(None),
        max_towers: 4,
    },
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 75, 0, 0, 0, 0, 0, 0, 0, 75, 0, 0, 0, 5, 0, 19, 0, 13, 96, 89, 120, 185, 79, 82, 223, 17, 139, 109, 131, 220, 222, 215, 32, 133, 1, 0, 2, 0, 0, 0, 19, 0, 13, 4, 93, 136, 138, 235, 28, 201, 17, 159, 232, 8, 0, 43, 16, 72, 96, 2, 0, 2, 0, 0, 0, 1, 0, 11, 2, 0, 0, 0, 1, 0, 7, 2, 0, 0, 135, 1, 0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0]
}

test_encoding_decoding! {
    ept_map_result,
    EptMapResult,
    EptMapResult {
        entry_handle: EntryHandle(None),
        towers: vec![
            vec![
                Floor::Uuid(UuidFloor {
                    uuid: uuid!("b9785960-524f-11df-8b6d-83dcded72085"),
                    version: 1,
                    version_minor: 0,
                }),
                Floor::Uuid(UuidFloor {
                    uuid: uuid!("8a885d04-1ceb-11c9-9fe8-08002b104860"),
                    version: 2,
                    version_minor: 0,
                }),
                Floor::RpcConnectionOriented(RpcConnectionOrientedFloor {
                    version_minor: 0,
                }),
                Floor::Tcp(TcpFloor {
                    port: 49668,
                }),
                Floor::Ip(IpFloor {
                    addr: u32::from_be_bytes([192, 168, 1, 104]),
                }),
            ],
            vec![
                Floor::Uuid(UuidFloor {
                    uuid: uuid!("b9785960-524f-11df-8b6d-83dcded72085"),
                    version: 1,
                    version_minor: 0,
                }),
                Floor::Uuid(UuidFloor {
                    uuid: uuid!("8a885d04-1ceb-11c9-9fe8-08002b104860"),
                    version: 2,
                    version_minor: 0,
                }),
                Floor::RpcConnectionOriented(RpcConnectionOrientedFloor {
                    version_minor: 0,
                }),
                Floor::Tcp(TcpFloor {
                    port: 49664,
                }),
                Floor::Ip(IpFloor {
                    addr: u32::from_be_bytes([192, 168, 1, 104]),
                }),
            ],
        ],
        status: 0,
    },
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 75, 0, 0, 0, 0, 0, 0, 0, 75, 0, 0, 0, 5, 0, 19, 0, 13, 96, 89, 120, 185, 79, 82, 223, 17, 139, 109, 131, 220, 222, 215, 32, 133, 1, 0, 2, 0, 0, 0, 19, 0, 13, 4, 93, 136, 138, 235, 28, 201, 17, 159, 232, 8, 0, 43, 16, 72, 96, 2, 0, 2, 0, 0, 0, 1, 0, 11, 2, 0, 0, 0, 1, 0, 7, 2, 0, 194, 4, 1, 0, 9, 4, 0, 192, 168, 1, 104, 0, 75, 0, 0, 0, 0, 0, 0, 0, 75, 0, 0, 0, 5, 0, 19, 0, 13, 96, 89, 120, 185, 79, 82, 223, 17, 139, 109, 131, 220, 222, 215, 32, 133, 1, 0, 2, 0, 0, 0, 19, 0, 13, 4, 93, 136, 138, 235, 28, 201, 17, 159, 232, 8, 0, 43, 16, 72, 96, 2, 0, 2, 0, 0, 0, 1, 0, 11, 2, 0, 0, 0, 1, 0, 7, 2, 0, 194, 0, 1, 0, 9, 4, 0, 192, 168, 1, 104, 0, 0, 0, 0, 0]
}
