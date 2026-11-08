const MAX_PHOTOS = 20;
const IMAGE_EXTENSIONS = new Map([['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif']]);

export function uploadImageExtension(mimeType) {
  return IMAGE_EXTENSIONS.get(mimeType) || '';
}

// Image references may be local upload paths or ordinary http(s) URLs.  In
// particular, never treat a javascript:, data:, or protocol-relative value as
// an image just because it came from a client form.
export function isSafeImageReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function existingImages(vehicle) {
  const images = Array.isArray(vehicle?.images) ? vehicle.images : [];
  const legacy = vehicle?.image ? [vehicle.image] : [];
  const result = [];
  // The array is the saved display order. Keep an image-only legacy cover as
  // a fallback, but never move it ahead of an explicitly ordered photo list.
  for (const image of [...images, ...legacy]) {
    if (typeof image === 'string' && image && !result.includes(image)) result.push(image);
  }
  return result;
}

export function parseMainPhotoIndex(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function hasOwn(input, key) {
  return input && Object.prototype.hasOwnProperty.call(input, key) && input[key] !== '' && input[key] !== undefined;
}

function orderedPhotos(oldImages, newImages, value) {
  let order = value;
  if (typeof order === 'string') {
    try { order = JSON.parse(order); } catch { throw new Error('车辆照片顺序格式无效'); }
  }
  if (!Array.isArray(order)) throw new Error('车辆照片顺序格式无效');
  const references = [...oldImages, ...newImages.map((_, index) => `upload:${index}`)];
  const allowed = new Map(references.map((reference, index) => [reference, index < oldImages.length ? oldImages[index] : newImages[index - oldImages.length]]));
  // Require a complete permutation. An upload token refers only to a file in
  // this request, and saved URLs must belong to this vehicle. A bad order must
  // never silently remove old photos or accept another vehicle's image.
  if (allowed.size !== references.length || order.length !== references.length || new Set(order).size !== order.length || order.some(reference => typeof reference !== 'string' || !allowed.has(reference))) {
    throw new Error('车辆照片顺序必须完整保留所有已有和新增照片，且不能重复');
  }
  const images = order.map(reference => allowed.get(reference));
  if (new Set(images).size !== images.length) throw new Error('车辆照片不能重复');
  return { images, image: images[0] || '' };
}

/**
 * Build the complete photo list and select its cover image.  `existing` must
 * be the pre-upload list, while `uploaded` contains only files from this
 * request.  It throws a 400-shaped error before persistence on bad input.
 */
export function selectVehiclePhotos(existing, uploaded, options = {}) {
  const oldImages = [...existing];
  const newImages = [...uploaded];
  if (oldImages.some(image => !isSafeImageReference(image))) {
    throw new Error('已有车辆照片地址无效');
  }
  if (newImages.some(image => !isSafeImageReference(image))) {
    throw new Error('车辆照片地址无效');
  }
  if (oldImages.length + newImages.length > MAX_PHOTOS) {
    throw new Error('车辆照片最多保留20张，请减少本次上传数量');
  }
  const images = [...oldImages, ...newImages];
  if (hasOwn(options, 'main_image') && hasOwn(options, 'main_photo_index')) {
    throw new Error('请只指定一种主图选择方式');
  }

  if (Object.prototype.hasOwnProperty.call(options, 'photo_order') && options.photo_order !== undefined) {
    const selected = orderedPhotos(oldImages, newImages, options.photo_order);
    if (hasOwn(options, 'main_image')) {
      const requested = options.main_image;
      if (!isSafeImageReference(requested) || !oldImages.includes(requested)) {
        throw new Error('主图必须是该车辆已保存的照片');
      }
      if (requested !== selected.image) throw new Error('主图必须与照片顺序的第一张一致');
    }
    if (hasOwn(options, 'main_photo_index')) {
      const index = parseMainPhotoIndex(options.main_photo_index);
      if (index === null || index >= newImages.length) throw new Error('主图索引无效，请选择本次上传的照片');
      if (newImages[index] !== selected.image) throw new Error('主图必须与照片顺序的第一张一致');
    }
    return selected;
  }

  if (hasOwn(options, 'main_image')) {
    const requested = options.main_image;
    if (!isSafeImageReference(requested) || !oldImages.includes(requested)) {
      throw new Error('主图必须是该车辆已保存的照片');
    }
    return { images: [requested, ...images.filter(image => image !== requested)], image: requested };
  }

  if (hasOwn(options, 'main_photo_index')) {
    const index = parseMainPhotoIndex(options.main_photo_index);
    if (index === null || index >= newImages.length) {
      throw new Error('主图索引无效，请选择本次上传的照片');
    }
    const image = newImages[index];
    return { images: [image, ...images.filter(item => item !== image)], image };
  }

  const image = oldImages[0] || newImages[0] || '';
  return { images: image ? [image, ...images.filter(item => item !== image)] : [], image };
}

export function uploadedImagePaths(files = []) {
  return files.map(file => `/uploads/${file.filename}`);
}

export function removeUploadedFiles(files = [], fsModule) {
  for (const file of files) {
    if (!file?.path) continue;
    try { fsModule.unlinkSync(file.path); } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to clean rejected upload:', error.message);
    }
  }
}

export { MAX_PHOTOS };
