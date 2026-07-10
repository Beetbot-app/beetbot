fn main() {
    // Compile the Cast V2 CastMessage proto into a Rust module that
    // src/cast/protocol.rs re-exports. Output lands in $OUT_DIR and is
    // pulled in via include!(concat!(env!("OUT_DIR"), "/.../cast_channel.rs")).
    //
    // prost-build shells out to `protoc`; ship a vendored copy so
    // contributors don't need to `brew install protobuf` first.
    let protoc = protoc_bin_vendored::protoc_bin_path()
        .expect("vendored protoc not available for this target");
    // Safety: we're the only thing running at build.rs time; nothing
    // else mutates the environment in parallel.
    unsafe {
        std::env::set_var("PROTOC", protoc);
    }
    prost_build::compile_protos(
        &["src/cast/cast_channel.proto"],
        &["src/cast"],
    )
    .expect("failed to compile cast_channel.proto");
    println!("cargo:rerun-if-changed=src/cast/cast_channel.proto");

    tauri_build::build();
}
