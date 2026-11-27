export interface BookFile {
  name: string;
  content: string | Uint8Array<ArrayBuffer>;
}

const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

export function buildBookZip(files: BookFile[]): Blob {
  const records: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    crc ^= 0xffffffff;

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 paths; data is stored without compression.
    header.setUint16(12, 0x21, true); // 1980-01-01 (minimum valid ZIP date).
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    new Uint8Array(entry.buffer).set(new Uint8Array(header.buffer, 4, 26), 6);
    entry.setUint32(42, offset, true);
    records.push(header.buffer, name, data);
    directory.push(entry.buffer, name);
    offset += header.byteLength + name.length + data.length;
    directorySize += entry.byteLength + name.length;
  }
  if (files.length > 65535 || offset + directorySize > 0xffffffff) throw new Error('ZIP 超过允许的体积限制');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...records, ...directory, end.buffer], { type: 'application/zip' });
}
