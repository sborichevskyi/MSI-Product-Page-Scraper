import { chromium } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

import { toAvailability } from "./helpers/toAvailability.js";
import { toNum } from "./helpers/toNum.js";
import { cleanString } from "./helpers/cleanString.js";

export { toAvailability, toNum, cleanString };

// Виконується в браузері: функція серіалізується, тому всі хелпери — всередині неї
function extractInPage() {
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const text = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const abs = (u) => {
    try {
      return u ? new URL(u, location.href).href : null;
    } catch {
      return null;
    }
  };
  const meta = (n) =>
    q(`meta[property="${n}"],meta[name="${n}"]`)?.content || null;
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const list = (v) => [].concat(v ?? []);

  // 1) JSON-LD (якщо є — це найнадійніше джерело)
  const nodes = qa('script[type="application/ld+json"]').flatMap((s) => {
    try {
      const j = JSON.parse(s.textContent);
      return Array.isArray(j) ? j : (j["@graph"] ?? [j]);
    } catch {
      return []; // ignore broken JSON-LD
    }
  });
  const byType = (t) => nodes.find((n) => list(n?.["@type"]).includes(t));
  const product = byType("Product");
  const offer = list(product?.offers)[0];
  const agg = product?.aggregateRating;
  const ldCrumbs = byType("BreadcrumbList")?.itemListElement;

  // 2) Хлібні крихти
  const crumbs = ldCrumbs?.length
    ? ldCrumbs.map((it) => ({
        name: it.name ?? it.item?.name,
        url: abs(typeof it.item === "string" ? it.item : it.item?.["@id"]),
      }))
    : qa('[class*="breadcrumb"] li').map((li) => ({
        name: text(li),
        url: abs(q("a", li)?.getAttribute("href")),
      }));

  // Блок товару (без меню, футера і "схожих товарів")
  const detail = q(".product-detail") ?? document.body;

  // 3) Заголовок: на us-store.msi.com це h2.title (перший h1 на сторінці — банер cookies)
  const titleEl = q("h2.title, h1", detail);
  const title =
    product?.name ??
    text(titleEl) ??
    text(q('.breadcrumb [aria-current="page"]'));

  // 4) Ціна / наявність: блок #prices-wrapper і кнопка поруч (#product_qty)
  const priceBox = q("#prices-wrapper", detail);
  const priceNew = text(
    q("#prices-new, .prices-new, .price-new", priceBox ?? detail),
  );
  const priceOld = text(q(".prices-old, .price-old", priceBox ?? detail));
  const stockText = [text(priceBox), text(q("#product_qty", detail))].join(" ");
  const stockRules = [
    [/out of stock/i, "out_of_stock"],
    [/pre-?order/i, "pre_order"],
    [/add to cart|buy now/i, "in_stock"],
    [/notify me/i, "out_of_stock"],
  ];
  const availability =
    stockRules.find(([re]) => re.test(stockText))?.[1] ?? null;

  // 5) Опис: JSON-LD -> перший <p> після заголовка -> meta description
  const description =
    product?.description ||
    (titleEl &&
      text(q("p", titleEl.nextElementSibling ?? titleEl.parentElement))) ||
    meta("og:description") ||
    meta("description");

  // 6) Картинки: головне фото + карусель (popup_img), інакше JSON-LD / og:image
  const slides = qa(
    "#carouselImages .swiper-slide:not(.swiper-slide-duplicate) img[popup_img]",
    detail,
  );
  const gallery = uniq(
    [
      q("#imagePopup", detail)?.getAttribute("src"),
      ...slides.map((i) => i.getAttribute("popup_img")),
    ].map(abs),
  );
  const ldImages = list(product?.image).map((i) =>
    typeof i === "string" ? i : i?.url,
  );
  const images = gallery.length
    ? gallery
    : uniq([...ldImages, meta("og:image")].map(abs));

  // 7) Специфікації: усі рядки таблиць з 2 клітинками
  const specs = [];
  for (const tr of qa("table tr")) {
    const cells = qa(":scope > th, :scope > td", tr);
    const name = cells.length === 2 && text(cells[0]);
    if (!name) continue;
    const value = cells[1].innerText
      .split("\n")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("; ");
    specs.push({ name, value: value && value !== "-" ? value : null });
  }

  // Рейтинг у DOM: "4.7 (3)"
  const rating = text(q("#average-rating-info", detail))?.match(
    /([\d.]+)\s*\((\d+)\)/,
  );

  return {
    ld: {
      sku: product?.sku ?? product?.productID,
      mpn: product?.mpn,
      gtin: ["gtin", "gtin13", "gtin12", "gtin14", "gtin8"]
        .map((k) => product?.[k])
        .find((v) => v != null),
      brand:
        typeof product?.brand === "string"
          ? product.brand
          : product?.brand?.name,
      category: product?.category,
      price: offer?.price,
      availability: offer?.availability,
      ratingValue: agg?.ratingValue,
      reviewCount: agg?.reviewCount ?? agg?.ratingCount,
    },
    dom: {
      // Якщо є стара ціна, то price = стара, salePrice = поточна
      price: priceOld ?? priceNew,
      salePrice: priceOld ? priceNew : null,
      availability,
      ratingValue: rating?.[1],
      reviewCount: rating?.[2],
    },
    productId: q('input[name="product_id"]')?.value,
    title,
    description,
    crumbs,
    images,
    specs,
  };
}

export async function scrapeProduct(url) {
  // запускаємо звичайний браузер, але з вікном за межами екрана
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-position=-32000,-32000",
    ],
  });
  try {
    const page = await browser.newPage();
    const res = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (res?.status() >= 400) {
      throw new Error(
        `Blocked or failed: HTTP ${res.status()} "${await page.title()}" for ${url}`,
      );
    }
    // Чекаємо догрузку, але не падаємо, якщо не дочекались
    const ignore = () => {};
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(ignore);
    await page
      .waitForSelector("#prices-wrapper, table", { timeout: 10_000 })
      .catch(ignore);

    const { ld, dom, ...raw } = await page.evaluate(extractInPage);

    // Крихти: без "Home" і без поточного товару (він зазвичай без посилання)
    const category_tree = raw.crumbs
      .map((c) => ({ name: cleanString(c.name), url: c.url }))
      .filter((c) => c.name && c.url && !/^home$/i.test(c.name));

    const title = cleanString(raw.title);
    const isMsi =
      /^MSI\b/i.test(title ?? "") || /msi\.com$/i.test(new URL(url).hostname);
    const manufacturerNumber = raw.specs.find((s) =>
      /^manufacturer number$/i.test(s.name),
    )?.value;

    return {
      url,
      item_id: cleanString(ld.sku) ?? cleanString(raw.productId),
      title,
      brand: cleanString(ld.brand) ?? (isMsi ? "MSI" : null),
      product_category:
        cleanString(ld.category) ??
        (category_tree.map((c) => c.name).join(" > ") || null),
      category_tree,
      description: cleanString(raw.description),
      // Якщо є знижка ("WAS $A  $B"), то price = A (стара), sale_price = B (поточна)
      price: toNum(ld.price) ?? toNum(dom.price),
      sale_price: ld.price != null ? null : toNum(dom.salePrice),
      availability: toAvailability(ld.availability) ?? dom.availability,
      image_url: raw.images[0] ?? null,
      additional_image_urls: raw.images.slice(1),
      specs: raw.specs,
      star_rating: toNum(ld.ratingValue) ?? toNum(dom.ratingValue),
      review_count: toNum(ld.reviewCount) ?? toNum(dom.reviewCount),
      gtin: cleanString(ld.gtin),
      mpn: cleanString(ld.mpn) ?? cleanString(manufacturerNumber),
      scraped_at: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node src/scrape.js <product-url>");
    process.exit(1);
  }
  // Результат пишемо в ../output/product.json (перезаписуємо попередній)
  const outDir = new URL("../output/", import.meta.url);
  const outFile = new URL("product.json", outDir);
  const json = JSON.stringify(await scrapeProduct(url), null, 2);
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, json + "\n", "utf8");
  console.log(json);
  console.log(`Saved to ${fileURLToPath(outFile)}`);
}
