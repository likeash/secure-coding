const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const multer = require('multer');

const ALLOWED = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

const uploadTempRoot = path.resolve(__dirname, '../../storage/tmp-uploads');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdir(uploadTempRoot, { recursive: true }, (error) => cb(error, uploadTempRoot));
  },
  filename(req, file, cb) {
    cb(null, crypto.randomUUID());
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED.get(ext) !== file.mimetype) return cb(Object.assign(new Error('INVALID_FILE_TYPE'), { status: 400 }));
    cb(null, true);
  },
});

function validImageMagic(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (mime === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

async function validImageFile(filePath, mime) {
  const handle = await fsPromises.open(filePath, 'r');
  try {
    const prefix = Buffer.alloc(12);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return validImageMagic(prefix.subarray(0, bytesRead), mime);
  } finally {
    await handle.close();
  }
}

function isTemporaryUpload(filePath) {
  if (!filePath) return false;
  const relative = path.relative(uploadTempRoot, path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function cleanupTemporaryFiles(files) {
  await Promise.all((files || []).map(async (file) => {
    if (!isTemporaryUpload(file.path)) return;
    try {
      await fsPromises.unlink(file.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }));
}

function cleanupTemporaryUploadsAfterResponse(req, res, next) {
  res.once('finish', () => {
    cleanupTemporaryFiles(req.files).catch((error) => {
      if (process.env.NODE_ENV !== 'test') {
        console.error(`[${new Date().toISOString()}] upload cleanup failed`, error.code || '');
      }
    });
  });
  next();
}

module.exports = {
  upload,
  validImageMagic,
  validImageFile,
  cleanupTemporaryFiles,
  cleanupTemporaryUploadsAfterResponse,
  uploadTempRoot,
  ALLOWED,
};
