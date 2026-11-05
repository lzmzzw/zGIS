//! Development-only fixtures. Write APIs are deliberately absent from the application worker.
use libloading::Library;
use std::{
    ffi::{c_char, c_int, c_void, CString},
    path::{Path, PathBuf},
    ptr,
};
type Handle = *mut c_void;
macro_rules! api {
    ($($name:ident: $ty:ty),+ $(,)?) => {
        #[allow(non_snake_case)]
        struct Api { _library: Library, $($name: $ty,)+ }
        impl Api {
            #[allow(non_snake_case)]
            unsafe fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
                let library = Library::new(path)?;
                $(let $name = *library.get::<$ty>(concat!(stringify!($name), "\0").as_bytes())?;)+
                Ok(Self { _library: library, $($name,)+ })
            }
        }
    }
}
api! {
    GDALAllRegister: unsafe extern "C" fn(),
    CPLSetConfigOption: unsafe extern "C" fn(*const c_char, *const c_char),
    GDALGetDriverByName: unsafe extern "C" fn(*const c_char) -> Handle,
    GDALGetDriverCount: unsafe extern "C" fn() -> c_int,
    GDALGetDriver: unsafe extern "C" fn(c_int) -> Handle,
    GDALGetDriverShortName: unsafe extern "C" fn(Handle) -> *const c_char,
    GDALCreate: unsafe extern "C" fn(Handle, *const c_char, c_int, c_int, c_int, c_int, *const *const c_char) -> Handle,
    GDALClose: unsafe extern "C" fn(Handle) -> c_int,
    GDALDatasetCreateLayer: unsafe extern "C" fn(Handle, *const c_char, Handle, c_int, *const *const c_char) -> Handle,
    OSRNewSpatialReference: unsafe extern "C" fn(*const c_char) -> Handle,
    OSRImportFromEPSG: unsafe extern "C" fn(Handle, c_int) -> c_int,
    OSRSetAxisMappingStrategy: unsafe extern "C" fn(Handle, c_int),
    OSRDestroySpatialReference: unsafe extern "C" fn(Handle),
    OGR_Fld_Create: unsafe extern "C" fn(*const c_char, c_int) -> Handle,
    OGR_Fld_SetAlternativeName: unsafe extern "C" fn(Handle, *const c_char),
    OGR_Fld_SetSubType: unsafe extern "C" fn(Handle, c_int),
    OGR_Fld_Destroy: unsafe extern "C" fn(Handle),
    OGR_L_CreateField: unsafe extern "C" fn(Handle, Handle, c_int) -> c_int,
    OGR_L_GetLayerDefn: unsafe extern "C" fn(Handle) -> Handle,
    OGR_F_Create: unsafe extern "C" fn(Handle) -> Handle,
    OGR_F_SetFieldString: unsafe extern "C" fn(Handle, c_int, *const c_char),
    OGR_F_SetFieldInteger64: unsafe extern "C" fn(Handle, c_int, i64),
    OGR_F_SetFieldNull: unsafe extern "C" fn(Handle, c_int),
    OGR_F_SetFieldBinary: unsafe extern "C" fn(Handle, c_int, c_int, *const u8),
    OGR_F_SetGeometryDirectly: unsafe extern "C" fn(Handle, Handle) -> c_int,
    OGR_G_CreateFromWkt: unsafe extern "C" fn(*mut *mut c_char, Handle, *mut Handle) -> c_int,
    OGR_L_CreateFeature: unsafe extern "C" fn(Handle, Handle) -> c_int,
    OGR_F_Destroy: unsafe extern "C" fn(Handle),
}
fn c(value: &str) -> CString {
    CString::new(value).expect("fixture text")
}
fn check(result: c_int, what: &str) {
    assert_eq!(result, 0, "fixture {what}");
}

unsafe fn create_layer(
    api: &Api,
    db: Handle,
    name: &str,
    epsg: Option<i32>,
    geometry_type: i32,
    geometries: &[Option<&str>],
    binary: bool,
) {
    let srs = epsg
        .map(|code| {
            let srs = (api.OSRNewSpatialReference)(ptr::null());
            check((api.OSRImportFromEPSG)(srs, code), "EPSG");
            (api.OSRSetAxisMappingStrategy)(srs, 0);
            srs
        })
        .unwrap_or(ptr::null_mut());
    let version = c("TARGET_ARCGIS_VERSION=ARCGIS_PRO_3_2_OR_LATER");
    let group = c("FEATURE_DATASET=survey");
    let options = [
        version.as_ptr(),
        if name == "projected" {
            group.as_ptr()
        } else {
            ptr::null()
        },
        ptr::null(),
    ];
    let layer =
        (api.GDALDatasetCreateLayer)(db, c(name).as_ptr(), srs, geometry_type, options.as_ptr());
    assert!(!layer.is_null(), "fixture create layer {name}");
    for (index, (field_name, kind)) in [
        ("name", 4),
        ("big", 12),
        ("nullable", 4),
        ("created", 11),
        ("guid", 4),
    ]
    .iter()
    .enumerate()
    {
        let field = (api.OGR_Fld_Create)(c(field_name).as_ptr(), *kind);
        if index == 0 {
            (api.OGR_Fld_SetAlternativeName)(field, c("中文名称").as_ptr());
        }
        if index == 4 {
            (api.OGR_Fld_SetSubType)(field, 5);
        }
        check((api.OGR_L_CreateField)(layer, field, 0), "field");
        (api.OGR_Fld_Destroy)(field);
    }
    if binary {
        let field = (api.OGR_Fld_Create)(c("blob").as_ptr(), 8);
        check((api.OGR_L_CreateField)(layer, field, 0), "binary field");
        (api.OGR_Fld_Destroy)(field);
    }
    for (index, wkt) in geometries.iter().enumerate() {
        let feature = (api.OGR_F_Create)((api.OGR_L_GetLayerDefn)(layer));
        (api.OGR_F_SetFieldString)(feature, 0, c(&format!("中文 {}", index + 1)).as_ptr());
        (api.OGR_F_SetFieldInteger64)(feature, 1, 9_007_199_254_740_993);
        if index % 2 == 0 {
            (api.OGR_F_SetFieldNull)(feature, 2);
        } else {
            (api.OGR_F_SetFieldString)(feature, 2, c("").as_ptr());
        }
        (api.OGR_F_SetFieldString)(feature, 3, c("2026/11/05 01:02:03+00").as_ptr());
        (api.OGR_F_SetFieldString)(
            feature,
            4,
            c("{12345678-1234-1234-1234-123456789ABC}").as_ptr(),
        );
        if binary {
            (api.OGR_F_SetFieldBinary)(feature, 5, 3, [0_u8, 1, 255].as_ptr());
        }
        if let Some(wkt) = wkt {
            let text = c(wkt);
            let mut position = text.as_ptr() as *mut c_char;
            let mut geometry = ptr::null_mut();
            check(
                (api.OGR_G_CreateFromWkt)(&mut position, srs, &mut geometry),
                "WKT",
            );
            check(
                (api.OGR_F_SetGeometryDirectly)(feature, geometry),
                "geometry",
            );
        }
        check((api.OGR_L_CreateFeature)(layer, feature), "feature");
        (api.OGR_F_Destroy)(feature);
    }
    if !srs.is_null() {
        (api.OSRDestroySpatialReference)(srs);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: gdb-fixtures <runtime-root> <new-output-directory>".into());
    }
    let root = std::fs::canonicalize(&args[0])?;
    let native = root.join("native");
    let mut libraries: Vec<PathBuf> = std::fs::read_dir(&native)?
        .filter_map(Result::ok)
        .map(|v| v.path())
        .filter(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            (name.starts_with("gdal") && name.ends_with(".dll"))
                || (name.starts_with("libgdal.") && name.ends_with(".dylib"))
        })
        .collect();
    libraries.sort();
    let library = libraries.first().ok_or("GDAL library missing")?;
    let current_path = std::env::var_os("PATH").unwrap_or_default();
    std::env::set_var(
        "PATH",
        std::env::join_paths(
            std::iter::once(native.clone()).chain(std::env::split_paths(&current_path)),
        )?,
    );
    let output = PathBuf::from(&args[1]);
    std::fs::create_dir_all(&output)?;
    let output = std::fs::canonicalize(output)?;
    let db_path = output.join("兼容性样本.gdb");
    if db_path.exists() {
        return Err("fixture GDB already exists; choose a fresh output directory".into());
    }
    unsafe {
        let api = Api::load(library)?;
        for (key, value) in [
            (
                "GDAL_DATA",
                root.join("data").to_string_lossy().into_owned(),
            ),
            (
                "PROJ_DATA",
                root.join("proj").to_string_lossy().into_owned(),
            ),
            ("PROJ_NETWORK", "OFF".into()),
        ] {
            (api.CPLSetConfigOption)(c(key).as_ptr(), c(&value).as_ptr());
        }
        (api.GDALAllRegister)();
        let mut drivers: Vec<String> = (0..(api.GDALGetDriverCount)())
            .map(|i| {
                std::ffi::CStr::from_ptr((api.GDALGetDriverShortName)((api.GDALGetDriver)(i)))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        drivers.sort();
        assert_eq!(
            drivers,
            ["MEM", "OpenFileGDB"],
            "Bundled GDAL must contain only the required drivers"
        );
        let driver = (api.GDALGetDriverByName)(c("OpenFileGDB").as_ptr());
        assert!(!driver.is_null(), "OpenFileGDB missing");
        let db = (api.GDALCreate)(
            driver,
            c(&db_path.to_string_lossy()).as_ptr(),
            0,
            0,
            0,
            0,
            ptr::null(),
        );
        assert!(!db.is_null(), "fixture create dataset");
        create_layer(
            &api,
            db,
            "points",
            Some(4326),
            1,
            &[Some("POINT (116 39)"), Some("POINT (117 40)"), None],
            false,
        );
        create_layer(
            &api,
            db,
            "binary",
            Some(4326),
            1,
            &[Some("POINT (116 39)")],
            true,
        );
        create_layer(
            &api,
            db,
            "xyz",
            Some(4326),
            1001,
            &[Some("POINT Z (116 39 123.5)")],
            false,
        );
        create_layer(
            &api,
            db,
            "projected",
            Some(3857),
            1,
            &[Some("POINT (12913060.932019735 4721671.572580108)")],
            false,
        );
        create_layer(
            &api,
            db,
            "cgcs",
            Some(4547),
            1,
            &[Some("POINT (500000 3320113.397845)")],
            false,
        );
        create_layer(&api, db, "polygon", Some(4326), 3, &[Some("POLYGON ((116 39,117 39,117 40,116 40,116 39),(116.2 39.2,116.2 39.8,116.8 39.8,116.8 39.2,116.2 39.2))")], false);
        create_layer(
            &api,
            db,
            "multipoint",
            Some(4326),
            4,
            &[Some("MULTIPOINT ((116 39),(117 40))")],
            false,
        );
        create_layer(
            &api,
            db,
            "measured",
            Some(4326),
            2001,
            &[Some("POINT M (116 39 5)")],
            false,
        );
        create_layer(
            &api,
            db,
            "curve",
            Some(4326),
            8,
            &[Some("CIRCULARSTRING (116 39,116.5 39.5,117 39)")],
            false,
        );
        create_layer(
            &api,
            db,
            "unknown_crs",
            None,
            1,
            &[Some("POINT (116 39)")],
            false,
        );
        create_layer(&api, db, "empty", Some(4326), 1, &[], false);
        check((api.GDALClose)(db), "close");
    }
    println!("Created isolated GDB fixtures: {}", db_path.display());
    Ok(())
}
