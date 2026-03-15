const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const chromium = require("@sparticuz/chromium");
const css = require("css");
const puppeteer = require("puppeteer-core");

const LOCAL_CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);

const LOCAL_CHROME_ARGS = [
  "--disable-setuid-sandbox",
  "--no-sandbox",
  "--ignore-certificate-errors",
  "--disable-dev-shm-usage",
];

const DYNAMIC_PSEUDO_PATTERN =
  /:(hover|active|focus|focus-visible|focus-within|visited|link|target|checked|disabled|enabled|placeholder-shown|valid|invalid|required|optional|read-only|read-write|autofill|fullscreen)\b/gi;

const normalizeSelector = (selector) =>
  selector
    .replace(/::[\w-]+/g, "")
    .replace(DYNAMIC_PSEUDO_PATTERN, "")
    .trim();

const shouldKeepSelectorByDefault = (selector) => {
  const normalized = normalizeSelector(selector);

  return (
    normalized === "" ||
    normalized === "*" ||
    normalized === "html" ||
    normalized === "body" ||
    normalized === ":root" ||
    normalized.includes(":root")
  );
};

const collectSelectors = (rules, selectors = new Set()) => {
  for (const rule of rules || []) {
    if (rule.type === "rule" && Array.isArray(rule.selectors)) {
      rule.selectors.forEach((selector) => selectors.add(selector));
      continue;
    }

    if (Array.isArray(rule.rules)) {
      collectSelectors(rule.rules, selectors);
    }
  }

  return selectors;
};

const filterRules = (rules, matches) => {
  const filteredRules = [];

  for (const rule of rules || []) {
    if (rule.type === "rule" && Array.isArray(rule.selectors)) {
      if (rule.selectors.some((selector) => matches[selector])) {
        filteredRules.push(rule);
      }

      continue;
    }

    if (Array.isArray(rule.rules)) {
      const nestedRules = filterRules(rule.rules, matches);

      if (nestedRules.length > 0) {
        filteredRules.push({ ...rule, rules: nestedRules });
      }

      continue;
    }

    if (rule.type === "font-face" || rule.type === "keyframes") {
      filteredRules.push(rule);
    }
  }

  return filteredRules;
};

const resolveChromeExecutablePath = async () => {
  for (const chromePath of LOCAL_CHROME_PATHS) {
    if (fsSync.existsSync(chromePath)) {
      return { executablePath: chromePath, useServerlessChromium: false };
    }
  }

  if (process.platform === "linux") {
    return {
      executablePath: await chromium.executablePath(),
      useServerlessChromium: true,
    };
  }

  throw new Error("Chrome executable not found. Set CHROME_PATH explicitly.");
};

const launchBrowser = async (width, height) => {
  const { executablePath, useServerlessChromium } =
    await resolveChromeExecutablePath();

  if (useServerlessChromium) {
    chromium.setGraphicsMode = false;

    return puppeteer.launch({
      args: puppeteer.defaultArgs({
        args: chromium.args,
        headless: "shell",
      }),
      defaultViewport: { width, height },
      executablePath,
      headless: "shell",
    });
  }

  return puppeteer.launch({
    args: LOCAL_CHROME_ARGS,
    defaultViewport: { width, height },
    executablePath,
    headless: true,
    ignoreHTTPSErrors: true,
  });
};

const getSelectorMatches = async (page, selectors, width, height) => {
  const selectorList = Array.from(selectors);

  return page.evaluate(
    ({ selectorList, width, height, dynamicPseudoPatternSource }) => {
      const dynamicPseudoPattern = new RegExp(dynamicPseudoPatternSource, "gi");
      const matches = {};

      const normalizeSelector = (selector) =>
        selector
          .replace(/::[\w-]+/g, "")
          .replace(dynamicPseudoPattern, "")
          .trim();

      for (const selector of selectorList) {
        const normalizedSelector = normalizeSelector(selector);

        if (
          normalizedSelector === "" ||
          normalizedSelector === "*" ||
          normalizedSelector === "html" ||
          normalizedSelector === "body" ||
          normalizedSelector === ":root" ||
          normalizedSelector.includes(":root")
        ) {
          matches[selector] = true;
          continue;
        }

        try {
          const elements = document.querySelectorAll(normalizedSelector);

          matches[selector] = Array.from(elements).some((element) => {
            const rect = element.getBoundingClientRect();

            return (
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < height &&
              rect.left < width
            );
          });
        } catch {
          matches[selector] = false;
        }
      }

      return matches;
    },
    {
      selectorList,
      width,
      height,
      dynamicPseudoPatternSource: DYNAMIC_PSEUDO_PATTERN.source,
    }
  );
};

module.exports = async ({
  htmlPath,
  stylePath,
  criticalPath,
  width,
  height,
}) => {
  const stylesheet = await fs.readFile(stylePath, "utf8");
  const ast = css.parse(stylesheet);
  const selectors = collectSelectors(ast.stylesheet.rules);
  const browser = await launchBrowser(width, height);

  try {
    const page = await browser.newPage();

    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();

      if (url.startsWith("file:") || url.startsWith("data:")) {
        request.continue();
        return;
      }

      request.abort();
    });

    await page.goto(pathToFileURL(path.resolve(htmlPath)).href, {
      waitUntil: "networkidle0",
    });

    await page.evaluate(() => {
      document
        .querySelectorAll(
          'link[rel="stylesheet"], link[rel="preload"][as="style"]'
        )
        .forEach((node) => node.remove());
    });
    await page.addStyleTag({ path: path.resolve(stylePath) });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const selectorMatches = await getSelectorMatches(
      page,
      selectors,
      width,
      height
    );
    const criticalRules = filterRules(ast.stylesheet.rules, selectorMatches);
    const criticalCss = css.stringify(
      { stylesheet: { rules: criticalRules } },
      { compress: true }
    );

    await fs.writeFile(criticalPath, criticalCss);
  } finally {
    await browser.close();
  }
};
