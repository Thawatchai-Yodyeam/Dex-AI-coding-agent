fn main() {
    // G-docx is embedded in the binary (include_dir), so changing the plugin needs a rebuild
    println!("cargo:rerun-if-changed=../plugins/gdocx");
    tauri_build::build()
}
