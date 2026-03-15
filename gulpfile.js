const gulp = require("gulp");
const htmlMinify = require("gulp-htmlmin");
const jsMinify = require("gulp-uglify");
const imgagemin = require("gulp-imagemin");
const { sync } = require("del");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const run = require("gulp-run");

const autoprefixer = require("gulp-autoprefixer");
const cssMinify = require("gulp-clean-css");
const gcssmq = require("gulp-group-css-media-queries");
const gulpSass = require("gulp-sass");
const sass = require("sass");
const concatCss = require("gulp-concat-css");
const generateCriticalCss = require("./scripts/generateCriticalCss");

const browserify = require("browserify");
const source = require("vinyl-source-stream");
const buffer = require("vinyl-buffer");
const sourcemaps = require("gulp-sourcemaps");
const log = require("gulplog");

const ts = require("gulp-typescript");
const tsify = require("tsify");

const browserSync = require("browser-sync");

const distDir = "./public/";
const srcDir = "./src/";

const htmlFiles = `${srcDir}*.html`;

const jsDir = "js/";
const jsInput = `${srcDir}${jsDir}index.js`;
const jsOutput = "app.js";

const tsDir = "ts/";
const tsFiles = [`${srcDir}${tsDir}*.ts`];
const tsIndexFile = [`${srcDir}${tsDir}index.ts`];
const tsCriticalFiles = [`${srcDir}${tsDir}critical/*.ts`];

const imgDir = "img/";
const imgFiles = `${srcDir}${imgDir}**/*`;

const stylesDir = "styles/";
const styleFiles = `${srcDir}${stylesDir}*.scss`;

const fontsDir = "fonts/";
const fontsFiles = `${srcDir}${fontsDir}**/*`;

const videosDir = "videos/";
const videoFiles = `${srcDir}${videosDir}**/*`;

const iconsDir = "icon/";
const iconsFiles = `${srcDir}${iconsDir}**/*`;

const processHTML = () => {
  return gulp
    .src(htmlFiles)
    .pipe(htmlMinify({ collapseWhitespace: true, removeComments: true }))
    .pipe(gulp.dest(distDir))
    .pipe(browserSync.reload({ stream: true }));
};

const processTS = () => {
  return browserify({
    entries: tsIndexFile,
    debug: true,
  })
    .plugin(tsify)
    .bundle()
    .pipe(source(jsOutput))
    .pipe(buffer())
    .pipe(sourcemaps.init({ loadMaps: true }))
    .pipe(jsMinify())
    .on("error", log.error)
    .pipe(sourcemaps.write("./"))
    .pipe(gulp.dest(`${distDir}${jsDir}`));
};

const processCriticalTS = () => {
  return gulp
    .src(`${tsCriticalFiles}`)
    .pipe(sourcemaps.init({ loadMaps: true }))
    .pipe(
      ts({
        noImplicitAny: true,
        module: "amd",
        moduleResolution: "node",
        outFile: `critical.js`,
      })
    )
    .pipe(jsMinify())
    .on("error", log.error)
    .pipe(sourcemaps.write("./"))
    .pipe(gulp.dest(`${distDir}${jsDir}critical/`));
};

const imageminBinaryPaths = [
  "node_modules/mozjpeg/vendor/cjpeg",
  "node_modules/optipng-bin/vendor/optipng",
  "node_modules/gifsicle/vendor/gifsicle",
];

const processIMG = () => {
  const imageStream = gulp.src(imgFiles);
  const hasImageminBinaries = imageminBinaryPaths.every((binaryPath) =>
    fsSync.existsSync(binaryPath)
  );

  if (!hasImageminBinaries) {
    log.warn(
      "Imagemin binaries are unavailable. Copying images without optimization."
    );
    return imageStream.pipe(gulp.dest(`${distDir}${imgDir}`));
  }

  return imageStream.pipe(imgagemin()).pipe(gulp.dest(`${distDir}${imgDir}`));
};

const gulpSassWorker = gulpSass(sass);

const processStyle = () => {
  return gulp
    .src(styleFiles)
    .pipe(gulpSassWorker().on("error", gulpSassWorker.logError))
    .pipe(autoprefixer({ grid: true }))
    .pipe(gcssmq())
    .pipe(concatCss("style.css"))
    .pipe(cssMinify())
    .pipe(gulp.dest(`${distDir}${stylesDir}`))
    .pipe(browserSync.stream());
};

const processCriticalCSS = async () => {
  const stylePath = path.join(distDir, stylesDir, "style.css");
  const htmlPath = path.join(distDir, "index.html");
  const criticalPath = path.join(distDir, stylesDir, "stylescritical.css");

  try {
    await generateCriticalCss({
      htmlPath,
      stylePath,
      criticalPath,
      width: 1400,
      height: 1200,
    });
  } catch (error) {
    log.warn(
      "Critical CSS generation failed. Falling back to full stylesheet."
    );
    log.warn(error);
    await fs.copyFile(stylePath, criticalPath);
  }
};

const clean = async () => {
  return sync(distDir, { force: true });
};

const watchDev = () => {
  gulp.watch(styleFiles, processStyle).on("change", browserSync.reload);
  gulp.watch(styleFiles, processCriticalCSS).on("change", browserSync.reload);
  gulp.watch(htmlFiles, processHTML).on("change", browserSync.reload);
  gulp.watch(imgFiles, processIMG).on("change", browserSync.reload);
  gulp.watch(tsFiles, processTS).on("change", browserSync.reload);
  gulp
    .watch(tsCriticalFiles, processCriticalTS)
    .on("change", browserSync.reload);
};

browserSync.create();

const initBrowserSync = () => {
  browserSync.init({
    server: {
      baseDir: distDir,
      serveStaticOptions: {
        extensions: ["html"],
      },
    },
    port: 8080,
    ui: { port: 8081 },
    open: true,
  });
};

const processFonts = () => {
  return gulp
    .src(fontsFiles)
    .pipe(gulp.dest(`${distDir}${fontsDir}`))
    .pipe(browserSync.stream());
};

const processVideos = () => {
  return gulp.src(videoFiles).pipe(gulp.dest(`${distDir}${videosDir}`));
};

const processIcons = () => {
  return gulp.src(iconsFiles).pipe(gulp.dest(`${distDir}${iconsDir}`));
};

const jobs = [
  clean,
  processStyle,
  processHTML,
  processTS,
  processCriticalTS,
  processIMG,
  processFonts,
  processVideos,
  processCriticalCSS,
  processIcons,
];

exports.build = gulp.series(...jobs);
exports.default = gulp.parallel(...jobs, initBrowserSync, watchDev);
