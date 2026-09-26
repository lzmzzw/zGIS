declare module "shpjs" {
  const shp: (
    input:
      | ArrayBuffer
      | { shp: ArrayBuffer; dbf?: ArrayBuffer; prj?: string; cpg?: string },
  ) => Promise<unknown>;
  export default shp;
}
