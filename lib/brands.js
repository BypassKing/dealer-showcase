const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEXT_LENGTH = 80;

export const defaultBrands = Object.freeze([
  { id: 1, slug: 'toyota', name: 'Toyota', name_zh: '丰田' },
  { id: 2, slug: 'honda', name: 'Honda', name_zh: '本田' },
  { id: 3, slug: 'nissan', name: 'Nissan', name_zh: '日产' },
  { id: 4, slug: 'hyundai', name: 'Hyundai', name_zh: '现代' },
  { id: 5, slug: 'kia', name: 'Kia', name_zh: '起亚' },
  { id: 6, slug: 'ford', name: 'Ford', name_zh: '福特' },
  { id: 7, slug: 'chevrolet', name: 'Chevrolet', name_zh: '雪佛兰' },
  { id: 8, slug: 'bmw', name: 'BMW', name_zh: '宝马' },
  { id: 9, slug: 'mercedes-benz', name: 'Mercedes-Benz', name_zh: '奔驰' },
  { id: 10, slug: 'volkswagen', name: 'Volkswagen', name_zh: '大众' },
  { id: 11, slug: 'audi', name: 'Audi', name_zh: '奥迪' },
  { id: 12, slug: 'lexus', name: 'Lexus', name_zh: '雷克萨斯' },
  { id: 13, slug: 'mazda', name: 'Mazda', name_zh: '马自达' },
  { id: 14, slug: 'subaru', name: 'Subaru', name_zh: '斯巴鲁' },
  { id: 15, slug: 'tesla', name: 'Tesla', name_zh: '特斯拉' },
  { id: 16, slug: 'volvo', name: 'Volvo', name_zh: '沃尔沃' },
  { id: 17, slug: 'peugeot', name: 'Peugeot', name_zh: '标致' },
  { id: 18, slug: 'renault', name: 'Renault', name_zh: '雷诺' },
  { id: 19, slug: 'byd', name: 'BYD', name_zh: '比亚迪' },
  { id: 20, slug: 'geely', name: 'Geely', name_zh: '吉利' },
]);

function text(value, field, required = true) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field}不能为空`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`);
  const clean = value.trim();
  if (required && !clean) throw new Error(`${field}不能为空`);
  if (clean.length > MAX_TEXT_LENGTH) throw new Error(`${field}不能超过${MAX_TEXT_LENGTH}个字符`);
  // Keep values as plain text. HTML is escaped at the rendering boundary; a
  // tag-looking value is rejected here as an additional defense in depth.
  if (/[<>\u0000-\u001f\u007f]/.test(clean)) throw new Error(`${field}包含不允许的字符`);
  return clean;
}

function logo(value, fallback = '') {
  const raw = value === undefined || value === null ? fallback : value;
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 500 || /[\u0000-\u001f\u007f<>]/.test(raw)) {
    throw new Error('品牌图标地址无效');
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid');
  } catch {
    throw new Error('品牌图标必须使用 HTTPS 地址');
  }
  return raw;
}

export function cleanBrand(input, fallback = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const slug = text(value.slug ?? fallback.slug, 'slug');
  if (!SLUG_PATTERN.test(slug) || slug.length > 60) throw new Error('slug只能使用小写字母、数字和短横线');
  const name = text(value.name ?? fallback.name, '品牌名称');
  const nameZh = text(value.name_zh ?? value.nameZh ?? fallback.name_zh ?? fallback.nameZh, '中文名称', false) || name;
  const brandLogo = logo(value.logo, fallback.logo);
  return brandLogo ? { slug, name, name_zh: nameZh, logo: brandLogo } : { slug, name, name_zh: nameZh };
}

export function cloneDefaultBrands() {
  return defaultBrands.map(brand => ({ ...brand }));
}

export function normalizeBrands(value) {
  if (!Array.isArray(value)) return cloneDefaultBrands();
  return value.filter(item => item && item.id !== undefined && item.id !== null).map(item => {
    try {
      const brand = cleanBrand(item);
      return { id: item.id, ...brand };
    } catch {
      // A bad optional legacy logo must not make an otherwise valid brand
      // disappear during a read or an unrelated admin write.
      try {
        const brand = cleanBrand({ ...item, logo: '' });
        return { id: item.id, ...brand };
      } catch {
        return null;
      }
    }
  }).filter(Boolean);
}

export function hasSlug(brands, slug, exceptId = undefined) {
  return brands.some(brand => brand.slug === slug && String(brand.id) !== String(exceptId));
}

export function nextBrandId(brands) {
  const ids = brands.map(brand => Number(brand.id)).filter(Number.isSafeInteger);
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

export { SLUG_PATTERN };
