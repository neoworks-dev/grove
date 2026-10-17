// The build loads SVG files as their markup, for `Icon`.
declare module "*.svg" {
  const markup: string;
  export default markup;
}
