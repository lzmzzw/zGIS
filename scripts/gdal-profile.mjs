import fs from "node:fs";
import path from "node:path";

// GDAL 3.13 still compiles VRT core support with its driver disabled. Its build
// helper consequently registers a non-readable VRT driver. Keep the core code
// but omit that registration from this explicitly limited runtime profile.
export function applySourceProfile(gdalDirectory) {
  const filename = path.join(gdalDirectory, "frmts/gdalallregister.cpp");
  const source = fs.readFileSync(filename, "utf8");
  const marker = "// zGIS OpenFileGDB profile: VRT core retained without driver registration.";
  if (source.includes(marker)) return;
  const registration = /#ifdef FRMT_vrt\r?\n\s+GDALRegister_VRT\(\);\r?\n#endif/;
  if (!registration.test(source)) throw new Error("Pinned GDAL VRT registration does not match the source profile patch");
  fs.writeFileSync(filename, source.replace(registration, marker));
}
