//! Minimal GDAL C ABI adapter, used exclusively in the isolated read-only worker.
//! All loaded function pointers remain owned by `Gdal` for their complete lifetime.
#[cfg(not(target_os = "emscripten"))]
use libloading::Library;
use serde_json::{json, Map, Value};
use std::{collections::{HashMap, HashSet}, ffi::{c_char, c_double, c_int, c_uint, c_void, CStr, CString}, fs, io, path::Path, ptr, sync::Mutex};

type Handle = *mut c_void;
type Strings = *const *const c_char;
type ErrorHandler = Option<unsafe extern "C" fn(c_int, c_int, *const c_char)>;
const MAX_RESULT: usize = 100 * 1024 * 1024;
const MAX_FIELD_BYTES: usize = 1024 * 1024;
const MAX_COORDS: usize = 2_000_000;
const MAX_FEATURE_COORDS: usize = 1_000_000;
#[cfg(target_os = "emscripten")]
const MAX_ZIP_UNCOMPRESSED: u64 = 200 * 1024 * 1024;
#[cfg(not(target_os = "emscripten"))]
const MAX_ZIP_UNCOMPRESSED: u64 = 8 * 1024 * 1024 * 1024;
static ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());

unsafe extern "C" fn error_handler(class: c_int, _code: c_int, message: *const c_char) {
    if class >= 2 {
        if let Ok(mut errors) = ERRORS.lock() {
            if errors.len() < 16 { errors.push(text(message).chars().take(2048).collect()); }
        }
    }
}
fn clear_errors() { if let Ok(mut errors) = ERRORS.lock() { errors.clear(); } }
fn check_errors() -> Result<(), String> {
    let mut errors = ERRORS.lock().map_err(|_| "GDB_GDAL_ERROR: diagnostics unavailable")?;
    if errors.is_empty() { Ok(()) } else { Err(format!("GDB_GDAL_ERROR: {}", std::mem::take(&mut *errors).join("; "))) }
}
fn text(value: *const c_char) -> String {
    if value.is_null() { String::new() } else { unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned() }
}
fn cstring(value: &str) -> Result<CString, String> { CString::new(value).map_err(|_| "GDB_VALUE_INVALID: embedded NUL".into()) }

macro_rules! gdal_api {
    ($($name:ident: unsafe extern "C" fn($($arg:ty),*) $(-> $ret:ty)?;)+) => {
        #[allow(non_snake_case)]
        struct Gdal {
            $($name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)+
            #[cfg(not(target_os = "emscripten"))]
            _library: Library,
        }
        #[cfg(target_os = "emscripten")]
        #[allow(non_snake_case)]
        mod gdal_link {
            use super::*;
            extern "C" { $(pub fn $name($(_: $arg),*) $(-> $ret)?;)+ }
        }
        #[allow(non_snake_case)]
        impl Gdal {
            #[cfg(not(target_os = "emscripten"))]
            unsafe fn from_library(library: Library) -> Result<Self, String> {
                $(let $name = *library.get::<unsafe extern "C" fn($($arg),*) $(-> $ret)?>(concat!(stringify!($name), "\0").as_bytes()).map_err(|_| concat!("GDB_RUNTIME_INVALID: missing ", stringify!($name)))?;)+
                Ok(Self { $($name,)+ _library: library })
            }
            #[cfg(target_os = "emscripten")]
            fn from_static() -> Self { Self { $($name: gdal_link::$name,)+ } }
        }
    }
}
gdal_api! {
    RegisterOGROpenFileGDB: unsafe extern "C" fn();
    GDALOpenEx: unsafe extern "C" fn(*const c_char, c_uint, Strings, Strings, Strings) -> Handle;
    GDALClose: unsafe extern "C" fn(Handle) -> c_int;
    GDALDatasetGetLayerCount: unsafe extern "C" fn(Handle) -> c_int;
    GDALDatasetGetLayer: unsafe extern "C" fn(Handle, c_int) -> Handle;
    GDALGetMetadataItem: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> *const c_char;
    GDALDatasetGetFieldDomain: unsafe extern "C" fn(Handle, *const c_char) -> Handle;
    GDALDatasetGetRootGroup: unsafe extern "C" fn(Handle) -> Handle;
    GDALGroupGetGroupNames: unsafe extern "C" fn(Handle, Strings) -> *mut *mut c_char;
    GDALGroupGetVectorLayerNames: unsafe extern "C" fn(Handle, Strings) -> *mut *mut c_char;
    GDALGroupOpenGroup: unsafe extern "C" fn(Handle, *const c_char, Strings) -> Handle;
    GDALGroupRelease: unsafe extern "C" fn(Handle);
    CSLDestroy: unsafe extern "C" fn(*mut *mut c_char);
    CPLSetConfigOption: unsafe extern "C" fn(*const c_char, *const c_char);
    CPLSetErrorHandler: unsafe extern "C" fn(ErrorHandler) -> ErrorHandler;
    VSIFree: unsafe extern "C" fn(Handle);
    OGR_L_GetName: unsafe extern "C" fn(Handle) -> *const c_char;
    OGR_L_GetGeomType: unsafe extern "C" fn(Handle) -> c_int;
    OGR_L_GetSpatialRef: unsafe extern "C" fn(Handle) -> Handle;
    OGR_L_GetLayerDefn: unsafe extern "C" fn(Handle) -> Handle;
    OGR_L_GetFIDColumn: unsafe extern "C" fn(Handle) -> *const c_char;
    OGR_L_GetFeatureCount: unsafe extern "C" fn(Handle, c_int) -> i64;
    OGR_L_ResetReading: unsafe extern "C" fn(Handle);
    OGR_L_GetNextFeature: unsafe extern "C" fn(Handle) -> Handle;
    OGR_L_SetSpatialFilterRect: unsafe extern "C" fn(Handle, c_double, c_double, c_double, c_double);
    OGR_L_SetIgnoredFields: unsafe extern "C" fn(Handle, Strings) -> c_int;
    OGR_FD_GetFieldCount: unsafe extern "C" fn(Handle) -> c_int;
    OGR_FD_GetFieldDefn: unsafe extern "C" fn(Handle, c_int) -> Handle;
    OGR_Fld_GetNameRef: unsafe extern "C" fn(Handle) -> *const c_char;
    OGR_Fld_GetAlternativeNameRef: unsafe extern "C" fn(Handle) -> *const c_char;
    OGR_Fld_GetType: unsafe extern "C" fn(Handle) -> c_int;
    OGR_Fld_GetSubType: unsafe extern "C" fn(Handle) -> c_int;
    OGR_Fld_IsNullable: unsafe extern "C" fn(Handle) -> c_int;
    OGR_Fld_GetDomainName: unsafe extern "C" fn(Handle) -> *const c_char;
    OGR_GetFieldTypeName: unsafe extern "C" fn(c_int) -> *const c_char;
    OGR_FldDomain_GetDescription: unsafe extern "C" fn(Handle) -> *const c_char;
    OGR_FldDomain_GetDomainType: unsafe extern "C" fn(Handle) -> c_int;
    OGR_F_IsFieldSetAndNotNull: unsafe extern "C" fn(Handle, c_int) -> c_int;
    OGR_F_GetFieldAsInteger64: unsafe extern "C" fn(Handle, c_int) -> i64;
    OGR_F_GetFieldAsDouble: unsafe extern "C" fn(Handle, c_int) -> c_double;
    OGR_F_GetFieldAsString: unsafe extern "C" fn(Handle, c_int) -> *const c_char;
    OGR_F_GetFID: unsafe extern "C" fn(Handle) -> i64;
    OGR_F_GetGeometryRef: unsafe extern "C" fn(Handle) -> Handle;
    OGR_F_Destroy: unsafe extern "C" fn(Handle);
    OGR_G_GetGeometryType: unsafe extern "C" fn(Handle) -> c_int;
    OGR_G_IsEmpty: unsafe extern "C" fn(Handle) -> c_int;
    OGR_G_Is3D: unsafe extern "C" fn(Handle) -> c_int;
    OGR_G_IsMeasured: unsafe extern "C" fn(Handle) -> c_int;
    OGR_G_GetGeometryCount: unsafe extern "C" fn(Handle) -> c_int;
    OGR_G_GetGeometryRef: unsafe extern "C" fn(Handle, c_int) -> Handle;
    OGR_G_GetPointCount: unsafe extern "C" fn(Handle) -> c_int;
    OGR_G_GetX: unsafe extern "C" fn(Handle, c_int) -> c_double;
    OGR_G_GetY: unsafe extern "C" fn(Handle, c_int) -> c_double;
    OGR_G_GetZ: unsafe extern "C" fn(Handle, c_int) -> c_double;
    OSRClone: unsafe extern "C" fn(Handle) -> Handle;
    OSRCloneGeogCS: unsafe extern "C" fn(Handle) -> Handle;
    OSRNewSpatialReference: unsafe extern "C" fn(*const c_char) -> Handle;
    OSRDestroySpatialReference: unsafe extern "C" fn(Handle);
    OSRImportFromEPSG: unsafe extern "C" fn(Handle, c_int) -> c_int;
    OSRExportToWkt: unsafe extern "C" fn(Handle, *mut *mut c_char) -> c_int;
    OSRGetAuthorityName: unsafe extern "C" fn(Handle, *const c_char) -> *const c_char;
    OSRGetAuthorityCode: unsafe extern "C" fn(Handle, *const c_char) -> *const c_char;
    OSRSetAxisMappingStrategy: unsafe extern "C" fn(Handle, c_int);
    OSRSetPROJSearchPaths: unsafe extern "C" fn(Strings);
    OSRSetPROJEnableNetwork: unsafe extern "C" fn(c_int);
    OSRIsGeographic: unsafe extern "C" fn(Handle) -> c_int;
    OSRIsProjected: unsafe extern "C" fn(Handle) -> c_int;
    OSRIsCompound: unsafe extern "C" fn(Handle) -> c_int;
    OCTNewCoordinateTransformationOptions: unsafe extern "C" fn() -> Handle;
    OCTCoordinateTransformationOptionsSetBallparkAllowed: unsafe extern "C" fn(Handle, c_int) -> c_int;
    OCTCoordinateTransformationOptionsSetOnlyBest: unsafe extern "C" fn(Handle, bool) -> c_int;
    OCTDestroyCoordinateTransformationOptions: unsafe extern "C" fn(Handle);
    OCTNewCoordinateTransformationEx: unsafe extern "C" fn(Handle, Handle, Handle) -> Handle;
    OCTDestroyCoordinateTransformation: unsafe extern "C" fn(Handle);
    OCTTransform: unsafe extern "C" fn(Handle, c_int, *mut c_double, *mut c_double, *mut c_double) -> c_int;
    OCTTransformBounds: unsafe extern "C" fn(Handle, c_double, c_double, c_double, c_double, *mut c_double, *mut c_double, *mut c_double, *mut c_double, c_int) -> c_int;
}

#[allow(non_snake_case)]
impl Gdal {
    fn load(root: &Path) -> Result<Self, String> {
        if !root.join("proj/proj.db").is_file() || !root.join("data").is_dir() { return Err("GDB_RUNTIME_MISSING: bundled GDAL/PROJ data unavailable".into()); }
        #[cfg(not(target_os = "emscripten"))]
        let api = {
        let native = root.join("native");
        #[cfg(windows)]
        let candidates = ["gdal.dll", "gdal313.dll", "gdal312.dll"];
        #[cfg(target_os = "macos")]
        let candidates = ["libgdal.dylib", "libgdal.39.dylib", "libgdal.38.dylib", "libgdal.37.dylib"];
        #[cfg(not(any(windows, target_os = "macos")))]
        let candidates = ["libgdal.so", "libgdal.so.38"];
        let file = candidates.iter().map(|name| native.join(name)).find(|p| p.is_file()).ok_or("GDB_RUNTIME_MISSING: bundled GDAL native library unavailable")?;
        // In worker mode only; changes never affect the host's library search directory.
        #[cfg(windows)]
        {
            #[link(name = "kernel32")]
            extern "system" { fn SetDllDirectoryW(path: *const u16) -> i32; }
            use std::os::windows::ffi::OsStrExt;
            let wide: Vec<u16> = native.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { SetDllDirectoryW(wide.as_ptr()) } == 0 { return Err("GDB_RUNTIME_INVALID: cannot configure bundled DLL directory".into()); }
        }
        unsafe { Self::from_library(Library::new(file).map_err(|e| format!("GDB_RUNTIME_INVALID: cannot load bundled GDAL ({e})"))?)? }
        };
        #[cfg(target_os = "emscripten")]
        let api = Self::from_static();
        unsafe {
            (api.CPLSetErrorHandler)(Some(error_handler));
            for (name, value) in [
                ("GDAL_DATA", root.join("data").to_string_lossy().into_owned()),
                ("PROJ_DATA", root.join("proj").to_string_lossy().into_owned()),
                ("PROJ_LIB", root.join("proj").to_string_lossy().into_owned()),
                ("PROJ_NETWORK", "OFF".into()), ("PROJ_ONLY_BEST_DEFAULT", "YES".into()),
                ("GDAL_DRIVER_PATH", "disable".into()), ("GDAL_PAM_ENABLED", "NO".into()),
                ("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", "".into()),
            ] { (api.CPLSetConfigOption)(cstring(name)?.as_ptr(), cstring(&value)?.as_ptr()); }
            let proj_path = cstring(&root.join("proj").to_string_lossy())?;
            let proj_paths = [proj_path.as_ptr(), ptr::null()];
            (api.OSRSetPROJSearchPaths)(proj_paths.as_ptr());
            (api.OSRSetPROJEnableNetwork)(0);
            (api.RegisterOGROpenFileGDB)();
        }
        check_errors()?;
        Ok(api)
    }
    fn groups(&self, dataset: Handle) -> Result<HashMap<String, String>, String> {
        unsafe fn names(api: &Gdal, list: *mut *mut c_char) -> Result<Vec<String>, String> {
            let mut names = Vec::new();
            if !list.is_null() {
                for i in 0..=2048 {
                    let pointer = *list.add(i);
                    if pointer.is_null() { break; }
                    if i == 2048 { (api.CSLDestroy)(list); return Err("GDB_CATALOG_LIMIT: too many groups or layers".into()); }
                    names.push(text(pointer));
                }
                (api.CSLDestroy)(list);
            }
            Ok(names)
        }
        unsafe fn recurse(api: &Gdal, group: Handle, path: &str, result: &mut HashMap<String, String>, depth: usize) -> Result<(), String> {
            if depth > 8 || result.len() > 2048 { return Err("GDB_CATALOG_LIMIT: group hierarchy exceeds budget".into()); }
            for name in names(api, (api.GDALGroupGetVectorLayerNames)(group, ptr::null()))? { if !path.is_empty() { result.insert(name, path.to_owned()); } }
            for name in names(api, (api.GDALGroupGetGroupNames)(group, ptr::null()))? {
                let child = (api.GDALGroupOpenGroup)(group, cstring(&name)?.as_ptr(), ptr::null());
                if child.is_null() { return Err("GDB_CATALOG_INVALID: cannot read feature dataset".into()); }
                let next = if path.is_empty() { name } else { format!("{path}/{name}") };
                let read = recurse(api, child, &next, result, depth + 1);
                (api.GDALGroupRelease)(child);
                read?;
            }
            Ok(())
        }
        let root = unsafe { (self.GDALDatasetGetRootGroup)(dataset) };
        let mut result = HashMap::new();
        if !root.is_null() {
            let read = unsafe { recurse(self, root, "", &mut result, 0) };
            unsafe { (self.GDALGroupRelease)(root); }
            read?;
        }
        Ok(result)
    }
}

struct Dataset<'a> { api: &'a Gdal, handle: Handle }
impl Drop for Dataset<'_> { fn drop(&mut self) { unsafe { (self.api.GDALClose)(self.handle); } } }
struct Feature<'a> { api: &'a Gdal, handle: Handle }
impl Drop for Feature<'_> { fn drop(&mut self) { unsafe { (self.api.OGR_F_Destroy)(self.handle); } } }
struct Transformation<'a> { api: &'a Gdal, source: Handle, target: Handle, forward: Handle, inverse: Handle, approximate: bool }
impl Drop for Transformation<'_> {
    fn drop(&mut self) { unsafe {
        if !self.forward.is_null() { (self.api.OCTDestroyCoordinateTransformation)(self.forward); }
        if !self.inverse.is_null() { (self.api.OCTDestroyCoordinateTransformation)(self.inverse); }
        (self.api.OSRDestroySpatialReference)(self.source); (self.api.OSRDestroySpatialReference)(self.target);
    } }
}
fn authority(api: &Gdal, srs: Handle) -> String {
    if srs.is_null() { return "Unknown".into(); }
    unsafe { let name = text((api.OSRGetAuthorityName)(srs, ptr::null())); let code = text((api.OSRGetAuthorityCode)(srs, ptr::null())); if name.is_empty() || code.is_empty() { "Custom CRS".into() } else { format!("{name}:{code}") } }
}
fn source_srs(api: &Gdal, layer: Handle) -> Result<(String, String, bool), String> {
    unsafe {
        let srs = (api.OGR_L_GetSpatialRef)(layer);
        if srs.is_null() { return Ok(("Unknown".into(), String::new(), false)); }
        let mut output = ptr::null_mut();
        if (api.OSRExportToWkt)(srs, &mut output) != 0 { return Err("GDB_CRS_INVALID: cannot read source CRS".into()); }
        let wkt = text(output); (api.VSIFree)(output.cast());
        let geog = (api.OSRCloneGeogCS)(srs);
        let cgcs = !geog.is_null() && authority(api, geog) == "EPSG:4490";
        if !geog.is_null() { (api.OSRDestroySpatialReference)(geog); }
        Ok((authority(api, srs), wkt, cgcs))
    }
}
impl<'a> Transformation<'a> {
    fn new(api: &'a Gdal, layer: Handle, allow_approximate: bool) -> Result<Self, String> {
        unsafe {
            let original = (api.OGR_L_GetSpatialRef)(layer);
            if original.is_null() { return Err("GDB_CRS_UNKNOWN: source CRS is missing; convert externally using a verified CRS".into()); }
            if (api.OSRIsCompound)(original) != 0 || ((api.OSRIsGeographic)(original) == 0 && (api.OSRIsProjected)(original) == 0) { return Err("GDB_CRS_UNSUPPORTED: only geographic/projected horizontal CRS is supported".into()); }
            let (_, _, cgcs) = source_srs(api, layer)?;
            let source = (api.OSRClone)(original);
            let target = (api.OSRNewSpatialReference)(ptr::null());
            if source.is_null() || target.is_null() {
                if !source.is_null() { (api.OSRDestroySpatialReference)(source); }
                if !target.is_null() { (api.OSRDestroySpatialReference)(target); }
                return Err("GDB_CRS_INVALID: cannot allocate coordinate system".into());
            }
            let mut result = Self { api, source, target, forward: ptr::null_mut(), inverse: ptr::null_mut(), approximate: cgcs && allow_approximate };
            if (api.OSRImportFromEPSG)(target, if result.approximate { 4490 } else { 4326 }) != 0 { return Err("GDB_CRS_INVALID: bundled PROJ cannot initialize target CRS".into()); }
            (api.OSRSetAxisMappingStrategy)(source, 0); (api.OSRSetAxisMappingStrategy)(target, 0);
            let options = (api.OCTNewCoordinateTransformationOptions)();
            if options.is_null() { return Err("GDB_CRS_INVALID: cannot allocate conversion options".into()); }
            let configured = (api.OCTCoordinateTransformationOptionsSetBallparkAllowed)(options, 0) != 0 && (api.OCTCoordinateTransformationOptionsSetOnlyBest)(options, true) != 0;
            if configured { result.forward = (api.OCTNewCoordinateTransformationEx)(source, target, options); result.inverse = (api.OCTNewCoordinateTransformationEx)(target, source, options); }
            (api.OCTDestroyCoordinateTransformationOptions)(options);
            if result.forward.is_null() || result.inverse.is_null() {
                clear_errors();
                return Err(if cgcs && !allow_approximate { "GDB_CRS_APPROXIMATION_REQUIRED: no exact CGCS2000 to WGS84 operation is available; explicitly allow approximate datum conversion for non-survey use or pre-convert externally" } else { "GDB_CRS_TRANSFORM_UNAVAILABLE: best non-ballpark coordinate operation is unavailable, possibly due to missing grid data" }.into());
            }
            check_errors()?;
            Ok(result)
        }
    }
    fn point(&self, mut x: f64, mut y: f64) -> Result<[f64; 2], String> {
        if !x.is_finite() || !y.is_finite() { return Err("GDB_COORDINATE_INVALID: non-finite source coordinate".into()); }
        if unsafe { (self.api.OCTTransform)(self.forward, 1, &mut x, &mut y, ptr::null_mut()) } == 0 || !x.is_finite() || !y.is_finite() || !(-180.0..=180.0).contains(&x) || !(-90.0..=90.0).contains(&y) {
            return Err("GDB_CRS_TRANSFORM_FAILED: source coordinate cannot be converted reliably to WGS84".into());
        }
        Ok([x, y])
    }
    fn filter(&self, layer: Handle, bounds: [f64; 4]) -> Result<(), String> {
        let [mut west, mut south, mut east, mut north] = [0.0; 4];
        let ok = unsafe { (self.api.OCTTransformBounds)(self.inverse, bounds[0], bounds[1], bounds[2], bounds[3], &mut west, &mut south, &mut east, &mut north, 41) };
        if ok == 0 || ![west, south, east, north].iter().all(|n| n.is_finite()) || west > east || south > north { return Err("GDB_BOUNDS_TRANSFORM_FAILED: cannot transform selected WGS84 bounds".into()); }
        unsafe { (self.api.OGR_L_SetSpatialFilterRect)(layer, west, south, east, north); }
        Ok(())
    }
}

fn geometry_kind(value: c_int) -> (u32, bool) {
    let value = value as u32; let code = value & 0x7fff_ffff;
    (code % 1000, code / 1000 >= 2)
}
fn geometry_name(value: c_int) -> String {
    let (base, measured) = geometry_kind(value);
    let base = match base { 0 => "Unknown", 1 => "Point", 2 => "LineString", 3 => "Polygon", 4 => "MultiPoint", 5 => "MultiLineString", 6 => "MultiPolygon", 7 => "GeometryCollection", 100 => "None", _ => "Unsupported" };
    format!("{base}{}{}", if value as u32 & 0x8000_0000 != 0 || ((value as u32 & 0x7fff_ffff) / 1000) % 2 == 1 { " Z" } else { "" }, if measured { " M" } else { "" })
}
#[derive(Clone)]
struct Field { name: String, index: c_int, kind: c_int, subtype: c_int, metadata: Value }
fn fields(api: &Gdal, dataset: Handle, layer: Handle) -> Result<Vec<Field>, String> {
    unsafe {
        let defn = (api.OGR_L_GetLayerDefn)(layer);
        let count = (api.OGR_FD_GetFieldCount)(defn);
        if !(0..=1023).contains(&count) { return Err("GDB_FIELD_LIMIT: layer exceeds 1024 fields including OID".into()); }
        let mut result = Vec::new(); let mut seen = HashSet::new();
        let oid = text((api.OGR_L_GetFIDColumn)(layer));
        if !oid.is_empty() { seen.insert(oid.clone()); result.push(Field { name: oid.clone(), index: -1, kind: 12, subtype: 0, metadata: json!({"name":oid,"type":"Integer64 (OID)","nullable":false}) }); }
        for index in 0..count {
            let field = (api.OGR_FD_GetFieldDefn)(defn, index);
            let name = text((api.OGR_Fld_GetNameRef)(field));
            if name.is_empty() || name.len() > 4096 || !seen.insert(name.clone()) { return Err("GDB_FIELD_INVALID: duplicate or invalid field name".into()); }
            let kind = (api.OGR_Fld_GetType)(field);
            let subtype = (api.OGR_Fld_GetSubType)(field);
            let field_type = if subtype == 1 { "Integer (Boolean)".into() } else if subtype == 5 { "String (UUID)".into() } else { text((api.OGR_GetFieldTypeName)(kind)) };
            let mut metadata = json!({"name":name,"type":field_type,"nullable":(api.OGR_Fld_IsNullable)(field) != 0});
            let alias = text((api.OGR_Fld_GetAlternativeNameRef)(field));
            if !alias.is_empty() { metadata["alias"] = json!(alias); }
            let domain = text((api.OGR_Fld_GetDomainName)(field));
            if !domain.is_empty() {
                let handle = (api.GDALDatasetGetFieldDomain)(dataset, cstring(&domain)?.as_ptr());
                let domain = if handle.is_null() { domain } else { json!({"name":domain,"description":text((api.OGR_FldDomain_GetDescription)(handle)),"type":(api.OGR_FldDomain_GetDomainType)(handle),"values":"Original encoded values retained"}).to_string() };
                if domain.len() > MAX_FIELD_BYTES { return Err("GDB_FIELD_LIMIT: domain metadata exceeds 1 MiB".into()); }
                metadata["domain"] = json!(domain);
            }
            result.push(Field { name, index, kind, subtype, metadata });
        }
        Ok(result)
    }
}
fn supported_field(kind: c_int) -> bool { matches!(kind, 0 | 2 | 4 | 9 | 10 | 11 | 12) }

struct Budget { coordinates: usize, feature_coordinates: usize }
impl Budget {
    fn add(&mut self, count: usize) -> Result<(), String> {
        self.coordinates = self.coordinates.checked_add(count).ok_or("GDB_COORDINATE_LIMIT")?;
        self.feature_coordinates = self.feature_coordinates.checked_add(count).ok_or("GDB_COORDINATE_LIMIT")?;
        if self.coordinates > MAX_COORDS || self.feature_coordinates > MAX_FEATURE_COORDS { return Err("GDB_COORDINATE_LIMIT: exceeds 1000000 positions per feature or 2000000 total".into()); }
        Ok(())
    }
}
fn geometry(api: &Gdal, handle: Handle, transform: &Transformation<'_>, budget: &mut Budget) -> Result<Value, String> {
    if handle.is_null() { return Ok(Value::Null); }
    unsafe {
        let (kind, measured) = geometry_kind((api.OGR_G_GetGeometryType)(handle));
        if measured || (api.OGR_G_IsMeasured)(handle) != 0 || !(1..=6).contains(&kind) { return Err("GDB_GEOMETRY_UNSUPPORTED: M/ZM, curves, collections and special geometries are not supported".into()); }
        if (api.OGR_G_IsEmpty)(handle) != 0 { return Err("GDB_GEOMETRY_UNSUPPORTED: empty non-null geometry cannot be represented faithfully".into()); }
        let z = (api.OGR_G_Is3D)(handle) != 0;
        let coordinates = match kind {
            1 | 2 => {
                let count = (api.OGR_G_GetPointCount)(handle);
                if count < 0 || kind == 1 && count != 1 { return Err("GDB_GEOMETRY_INVALID: invalid point count".into()); }
                budget.add(count as usize)?;
                let mut positions = Vec::with_capacity(count as usize);
                for i in 0..count {
                    let [x, y] = transform.point((api.OGR_G_GetX)(handle, i), (api.OGR_G_GetY)(handle, i))?;
                    let mut position = vec![json!(x), json!(y)];
                    if z { let z = (api.OGR_G_GetZ)(handle, i); if !z.is_finite() { return Err("GDB_COORDINATE_INVALID: non-finite elevation".into()); } position.push(json!(z)); }
                    positions.push(Value::Array(position));
                }
                if kind == 1 { positions.remove(0) } else { Value::Array(positions) }
            }
            3..=6 => {
                let count = (api.OGR_G_GetGeometryCount)(handle);
                if count < 0 || count as usize > MAX_FEATURE_COORDS { return Err("GDB_GEOMETRY_LIMIT: too many geometry parts".into()); }
                let mut parts = Vec::with_capacity(count as usize);
                for i in 0..count {
                    let child = (api.OGR_G_GetGeometryRef)(handle, i);
                    if child.is_null() { return Err("GDB_GEOMETRY_INVALID: missing geometry part".into()); }
                    if kind != 3 {
                        let (child_kind, child_measured) = geometry_kind((api.OGR_G_GetGeometryType)(child));
                        let expected = match kind { 4 => 1, 5 => 2, _ => 3 };
                        if child_kind != expected || child_measured || ((api.OGR_G_Is3D)(child) != 0) != z {
                            return Err("GDB_GEOMETRY_INVALID: inconsistent multi-geometry type or coordinate dimensions".into());
                        }
                    }
                    if kind == 3 {
                        // LinearRing is a LineString in the C API; avoid relying on its type ID.
                        let count = (api.OGR_G_GetPointCount)(child);
                        if count < 4 { return Err("GDB_GEOMETRY_INVALID: polygon ring has fewer than four positions".into()); }
                        budget.add(count as usize)?;
                        let mut ring = Vec::with_capacity(count as usize);
                        for i in 0..count {
                            let [x, y] = transform.point((api.OGR_G_GetX)(child, i), (api.OGR_G_GetY)(child, i))?;
                            let mut position = vec![json!(x), json!(y)];
                            if z { let z = (api.OGR_G_GetZ)(child, i); if !z.is_finite() { return Err("GDB_COORDINATE_INVALID: non-finite elevation".into()); } position.push(json!(z)); }
                            ring.push(Value::Array(position));
                        }
                        if ring.first() != ring.last() { return Err("GDB_GEOMETRY_INVALID: polygon ring is not closed".into()); }
                        parts.push(Value::Array(ring));
                    } else { parts.push(geometry(api, child, transform, budget)?["coordinates"].take()); }
                }
                Value::Array(parts)
            }
            _ => unreachable!(),
        };
        Ok(json!({"type":match kind { 1=>"Point",2=>"LineString",3=>"Polygon",4=>"MultiPoint",5=>"MultiLineString",_=>"MultiPolygon" },"coordinates":coordinates}))
    }
}

fn geometry_intersects_bounds(value: &Value, bounds: [f64; 4]) -> bool {
    if value.is_null() { return false; }
    fn collect(value: &Value, envelope: &mut [f64; 4]) {
        if let Some(items) = value.as_array() {
            if items.first().is_some_and(Value::is_number) {
                if let (Some(x), Some(y)) = (items.first().and_then(Value::as_f64), items.get(1).and_then(Value::as_f64)) { envelope[0] = envelope[0].min(x); envelope[1] = envelope[1].min(y); envelope[2] = envelope[2].max(x); envelope[3] = envelope[3].max(y); }
            } else { for child in items { collect(child, envelope); } }
        }
    }
    let mut envelope = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    collect(&value["coordinates"], &mut envelope);
    envelope[0] <= bounds[2] && envelope[2] >= bounds[0] && envelope[1] <= bounds[3] && envelope[3] >= bounds[1]
}

struct SizeCounter { bytes: usize, limit: usize }
impl io::Write for SizeCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.bytes = self.bytes.saturating_add(bytes.len()); if self.bytes > self.limit { Err(io::Error::other("GDB_OUTPUT_LIMIT")) } else { Ok(bytes.len()) } }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
fn json_size(value: &Value, limit: usize) -> Result<usize, String> {
    let mut counter = SizeCounter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| "GDB_OUTPUT_LIMIT: result exceeds 100 MiB")?;
    Ok(counter.bytes)
}
fn integer_value(value: i64) -> Value { if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) { json!(value) } else { json!(value.to_string()) } }

fn read_layer(api: &Gdal, dataset: Handle, layer: Handle, request: &Value) -> Result<Value, String> {
    let (declared_geometry, declared_measured) = geometry_kind(unsafe { (api.OGR_L_GetGeomType)(layer) });
    if declared_measured || !(1..=6).contains(&declared_geometry) {
        return Err("GDB_GEOMETRY_UNSUPPORTED: non-spatial, M/ZM, curves, collections and special geometry layers cannot be imported".into());
    }
    let limit = request["limit"].as_u64().unwrap_or(10_000);
    let limit = u32::try_from(limit).map_err(|_| "GDB_LIMIT_INVALID")?;
    let selected = request.get("fields").filter(|v| !v.is_null()).map(|v| serde_json::from_value::<Vec<String>>(v.clone()).map_err(|_| "GDB_FIELDS_INVALID")).transpose()?;
    let bounds = request.get("bounds").filter(|v| !v.is_null()).map(|v| serde_json::from_value::<[f64; 4]>(v.clone()).map_err(|_| "GDB_BOUNDS_INVALID")).transpose()?;
    crate::gdb_contract::validate_read(limit, selected.as_deref(), bounds)?;
    let all_fields = fields(api, dataset, layer)?;
    let selection: HashSet<_> = selected.as_ref().map(|s| s.iter().map(String::as_str).collect()).unwrap_or_else(|| all_fields.iter().map(|f| f.name.as_str()).collect());
    if selection.iter().any(|name| !all_fields.iter().any(|f| f.name == *name)) { return Err("GDB_FIELDS_INVALID: selected field does not exist".into()); }
    let chosen: Vec<_> = all_fields.iter().filter(|f| selection.contains(f.name.as_str())).collect();
    if chosen.iter().any(|f| !supported_field(f.kind)) { return Err("GDB_FIELD_UNSUPPORTED: deselect binary/list/unsupported fields before reading".into()); }
    let ignored = all_fields.iter().filter(|f| f.index >= 0 && !selection.contains(f.name.as_str())).map(|f| cstring(&f.name)).collect::<Result<Vec<_>, _>>()?;
    let ignored_pointers: Vec<_> = ignored.iter().map(|s| s.as_ptr()).chain(Some(ptr::null())).collect();
    unsafe { if (api.OGR_L_SetIgnoredFields)(layer, ignored_pointers.as_ptr()) != 0 { return Err("GDB_FIELDS_INVALID: driver could not apply field selection".into()); } }
    let (source_crs, source_wkt, _) = source_srs(api, layer)?;
    let transform = Transformation::new(api, layer, request["allowApproximateDatum"].as_bool().unwrap_or(false))?;
    if let Some(bounds) = bounds { transform.filter(layer, bounds)?; }
    unsafe { (api.OGR_L_ResetReading)(layer); }
    let mut output = Vec::new(); let mut truncated = false; let mut bytes = 0usize;
    let mut budget = Budget { coordinates: 0, feature_coordinates: 0 };
    loop {
        let handle = unsafe { (api.OGR_L_GetNextFeature)(layer) };
        if handle.is_null() { break; }
        let feature = Feature { api, handle };
        check_errors()?;
        budget.feature_coordinates = 0;
        let shape = geometry(api, unsafe { (api.OGR_F_GetGeometryRef)(handle) }, &transform, &mut budget)?;
        if bounds.is_some_and(|b| !geometry_intersects_bounds(&shape, b)) { continue; }
        if output.len() >= limit as usize { truncated = true; break; }
        let fid = unsafe { (api.OGR_F_GetFID)(handle) };
        if fid < 0 { return Err("GDB_IDENTITY_UNSUPPORTED: driver did not provide a faithful feature identifier".into()); }
        let mut properties = Map::new();
        for field in &chosen {
            let value = unsafe {
                if field.index < 0 { json!(fid.to_string()) }
                else if (api.OGR_F_IsFieldSetAndNotNull)(handle, field.index) == 0 { Value::Null }
                else { match field.kind {
                    0 if field.subtype == 1 => { let value = (api.OGR_F_GetFieldAsInteger64)(handle, field.index); if value != 0 && value != 1 { return Err("GDB_FIELD_INVALID: invalid Boolean value".into()); } json!(value == 1) },
                    0 | 12 => integer_value((api.OGR_F_GetFieldAsInteger64)(handle, field.index)),
                    2 => { let value = (api.OGR_F_GetFieldAsDouble)(handle, field.index); if !value.is_finite() { return Err("GDB_FIELD_INVALID: non-finite numeric attribute".into()); } json!(value) }
                    4 | 9 | 10 | 11 => { let value = text((api.OGR_F_GetFieldAsString)(handle, field.index)); if value.len() > MAX_FIELD_BYTES { return Err("GDB_FIELD_LIMIT: attribute exceeds 1 MiB".into()); } json!(value) }
                    _ => return Err("GDB_FIELD_UNSUPPORTED: unsupported selected field type".into()),
                } }
            };
            properties.insert(field.name.clone(), value);
        }
        let result = json!({"id":format!("gdb-{fid}"),"sourceFeatureId":fid.to_string(),"geometry":shape,"properties":properties});
        bytes = bytes.saturating_add(json_size(&result, MAX_RESULT.saturating_sub(bytes))? + 1);
        if bytes > MAX_RESULT - 1024 * 1024 { return Err("GDB_OUTPUT_LIMIT: selected data leaves insufficient room for result metadata".into()); }
        output.push(result);
        drop(feature);
    }
    check_errors()?;
    let mut warnings = vec!["Only selected features and fields are loaded; exports contain this snapshot, not the complete geodatabase.".to_string()];
    if truncated { warnings.push(format!("Read limit {limit} reached; this is a partial layer.")); }
    if transform.approximate { warnings.push("Explicit approximate CGCS2000/WGS84 datum conversion: XY only, not suitable for surveying; Z is retained without vertical datum conversion.".into()); }
    else { warnings.push("XY transformed to WGS84; Z is retained without vertical datum conversion.".into()); }
    let description = if transform.approximate { "CGCS2000 projection to EPSG:4490; explicitly approved approximate datum identity to WGS84; traditional GIS XY axis order; original Z retained; not for surveying" } else { "GDAL/PROJ best available non-ballpark operation to EPSG:4326; traditional GIS XY axis order; original Z retained; no vertical datum conversion" };
    let result = json!({"loadedCount":output.len(),"features":output,"sourceCrs":source_crs,"sourceCrsWkt":source_wkt,"fields":chosen.iter().map(|f| &f.metadata).collect::<Vec<_>>(),"geometryType":geometry_name(unsafe { (api.OGR_L_GetGeomType)(layer) }),"warnings":warnings,"truncated":truncated,"readLimit":limit,"bounds":bounds,"sourceFingerprint":"worker-readonly","transformation":description});
    json_size(&result, MAX_RESULT - 1024)?;
    Ok(result)
}

fn dataset_path(source: &Path) -> Result<String, String> {
    let path = source.to_string_lossy().replace('\\', "/");
    let path = path.strip_prefix("//?/").unwrap_or(&path).to_owned();
    if source.is_dir() { return Ok(path); }
    let mut archive = zip::ZipArchive::new(fs::File::open(source).map_err(|_| "GDB_SOURCE_MISSING")?).map_err(|_| "GDB_ZIP_INVALID: cannot read ZIP directory")?;
    if archive.len() > 10000 { return Err("GDB_ZIP_LIMIT: ZIP contains too many members".into()); }
    let mut roots = HashSet::new(); let mut bytes = 0u64;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| "GDB_ZIP_INVALID: cannot inspect ZIP member")?;
        let name = entry.name().replace('\\', "/");
        if entry.enclosed_name().is_none() || name.starts_with('/') || name.split('/').any(|p| p == ".." || p.contains(':')) || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) { return Err("GDB_ZIP_INVALID: unsafe member path".into()); }
        bytes = bytes.saturating_add(entry.size());
        if bytes > MAX_ZIP_UNCOMPRESSED { return Err(format!("GDB_ZIP_LIMIT: ZIP exceeds {} MiB uncompressed budget", MAX_ZIP_UNCOMPRESSED / 1024 / 1024)); }
        if let Some(root) = name.split('/').next().filter(|s| s.to_lowercase().ends_with(".gdb")) { roots.insert(root.to_owned()); }
        else if !name.trim_end_matches('/').is_empty() { return Err("GDB_ZIP_INVALID: expected a single top-level .gdb directory".into()); }
    }
    if roots.len() != 1 { return Err("GDB_ZIP_INVALID: expected a single top-level .gdb directory".into()); }
    Ok(format!("/vsizip/{{{path}}}/{}", roots.into_iter().next().unwrap()))
}

pub(crate) fn execute(runtime_root: &Path, request: &Value) -> Result<Value, String> {
    clear_errors();
    let path = request["path"].as_str().ok_or("GDB_REQUEST_INVALID: missing source path")?;
    let path = crate::gdb_contract::source_path(Path::new(path))?;
    let path = dataset_path(&path)?;
    let api = Gdal::load(runtime_root)?;
    let path = cstring(&path)?;
    let driver = cstring("OpenFileGDB")?; let drivers = [driver.as_ptr(), ptr::null()];
    let handle = unsafe { (api.GDALOpenEx)(path.as_ptr(), 4 | 64, drivers.as_ptr(), ptr::null(), ptr::null()) };
    if handle.is_null() { return check_errors().and(Err("GDB_OPEN_FAILED: source is not a supported File Geodatabase".into())); }
    let dataset = Dataset { api: &api, handle };
    check_errors()?;
    let count = unsafe { (api.GDALDatasetGetLayerCount)(handle) };
    if !(0..=2048).contains(&count) { return Err("GDB_CATALOG_LIMIT: geodatabase exceeds 2048 layers".into()); }
    let operation = request["operation"].as_str().ok_or("GDB_REQUEST_INVALID: missing operation")?;
    if operation == "read" {
        let name = request["layerName"].as_str().ok_or("GDB_REQUEST_INVALID: missing layer name")?;
        for index in 0..count {
            let layer = unsafe { (api.GDALDatasetGetLayer)(handle, index) };
            if !layer.is_null() && unsafe { text((api.OGR_L_GetName)(layer)) } == name { return read_layer(&api, handle, layer, request); }
        }
        return Err("GDB_LAYER_MISSING: selected layer does not exist".into());
    }
    if operation != "catalog" { return Err("GDB_REQUEST_INVALID: unsupported operation".into()); }
    let groups = api.groups(dataset.handle)?;
    let mut layers = Vec::new(); let mut seen = HashSet::new();
    for index in 0..count {
        let layer = unsafe { (api.GDALDatasetGetLayer)(handle, index) };
        if layer.is_null() { return Err("GDB_CATALOG_INVALID: cannot access a layer".into()); }
        let name = unsafe { text((api.OGR_L_GetName)(layer)) };
        if name.is_empty() || !seen.insert(name.clone()) { return Err("GDB_CATALOG_INVALID: empty or duplicate layer name".into()); }
        let kind = unsafe { (api.OGR_L_GetGeomType)(layer) };
        let (base, measured) = geometry_kind(kind);
        let (source_crs, source_wkt, cgcs) = source_srs(&api, layer)?;
        let reason = if measured || !(1..=6).contains(&base) { Some("Only ordinary Point/LineString/Polygon and Multi XY/XYZ vector layers can be loaded; non-spatial tables, M/ZM, curves and collections are unsupported") } else if source_wkt.is_empty() { Some("Source CRS is missing; pre-convert using a verified CRS") } else { None };
        let schema = fields(&api, handle, layer)?;
        let mut warnings = Vec::new();
        if schema.iter().any(|f| !supported_field(f.kind)) { warnings.push("Unsupported binary/list fields must be deselected before reading"); }
        if cgcs { warnings.push("CGCS2000: explicitly enable approximate datum conversion for non-survey use if an exact WGS84 operation is unavailable"); }
        let feature_count = unsafe { (api.OGR_L_GetFeatureCount)(layer, 0) };
        let mut value = json!({"name":name,"geometryType":geometry_name(kind),"featureCount":if (0..=9_007_199_254_740_991).contains(&feature_count) { Some(feature_count) } else { None },"sourceCrs":source_crs,"sourceCrsWkt":source_wkt,"fields":schema.iter().map(|f| &f.metadata).collect::<Vec<_>>(),"supported":reason.is_none(),"warnings":warnings});
        if let Some(reason) = reason { value["reason"] = json!(reason); }
        if let Some(group) = groups.get(&name) { value["group"] = json!(group); }
        let alias = unsafe { text((api.GDALGetMetadataItem)(layer, cstring("ALIAS_NAME")?.as_ptr(), ptr::null())) };
        if !alias.is_empty() { value["alias"] = json!(alias); }
        layers.push(value);
    }
    check_errors()?;
    let result = json!({"layers":layers,"warnings":["GDB is opened read-only. Relationships, topology, attachments and rasters are not imported."]});
    json_size(&result, 8 * 1024 * 1024)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_flags_reject_measured_without_confusing_z() {
        assert_eq!(geometry_kind(1), (1, false));
        assert_eq!(geometry_kind(0x8000_0001u32 as i32), (1, false));
        assert_eq!(geometry_kind(1003), (3, false));
        assert_eq!(geometry_kind(2001), (1, true));
        assert_eq!(geometry_kind(3006), (6, true));
    }
    #[test]
    fn unsafe_integers_remain_exact_text_and_null_is_not_empty() {
        assert_eq!(integer_value(42), json!(42));
        assert_eq!(integer_value(9_007_199_254_740_992), json!("9007199254740992"));
        assert_eq!(integer_value(i64::MIN), json!(i64::MIN.to_string()));
        assert_ne!(Value::Null, json!(""));
    }
    #[test]
    fn coordinate_budget_counts_xyz_as_one_position() {
        let mut budget = Budget { coordinates: MAX_COORDS - 1, feature_coordinates: 0 };
        assert!(budget.add(1).is_ok());
        assert!(budget.add(1).is_err());
        let mut budget = Budget { coordinates: 0, feature_coordinates: MAX_FEATURE_COORDS };
        assert!(budget.add(1).is_err());
    }
    #[test]
    fn output_budget_counts_utf8_and_json_escaping() {
        let value = json!({"name":"中文\n\""});
        let bytes = serde_json::to_vec(&value).unwrap().len();
        assert_eq!(json_size(&value, bytes).unwrap(), bytes);
        assert!(json_size(&value, bytes - 1).is_err());
    }
    #[test]
    fn bounds_recheck_excludes_null_and_outside_geometries() {
        let bounds = [110.0, 20.0, 120.0, 30.0];
        assert!(geometry_intersects_bounds(&json!({"type":"Point","coordinates":[115.0,25.0,9.0]}), bounds));
        assert!(!geometry_intersects_bounds(&json!({"type":"Point","coordinates":[0.0,0.0]}), bounds));
        assert!(!geometry_intersects_bounds(&Value::Null, bounds));
    }
    #[test]
    fn zip_source_requires_one_safe_top_level_gdb() {
        use std::io::Write;
        fn archive(path: &Path, names: &[&str]) {
            let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
            for name in names {
                zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(b"fixture").unwrap();
            }
            zip.finish().unwrap();
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source.gdb.zip");
        archive(&path, &["source.gdb/a00000001.gdbtable"]);
        assert!(dataset_path(&path).unwrap().ends_with("}/source.gdb"));
        archive(&path, &["first.gdb/a.gdbtable", "second.gdb/a.gdbtable"]);
        assert!(dataset_path(&path).is_err());
        archive(&path, &["../source.gdb/a.gdbtable"]);
        assert!(dataset_path(&path).is_err());
        archive(&path, &["README.txt", "source.gdb/a.gdbtable"]);
        assert!(dataset_path(&path).is_err());
    }
}
