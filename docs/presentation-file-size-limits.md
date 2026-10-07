# ขนาดไฟล์นำเสนอสูงสุด

ข้อมูล ณ วันที่ 8 ตุลาคม 2026

| ประเภทผลงาน | ขนาดสูงสุด | Bytes | จำนวนหน้า PDF |
| --- | ---: | ---: | --- |
| Oral | 50 MB | 52,428,800 | อย่างน้อย 2 หน้า ไม่จำกัดสูงสุด |
| Poster / Highlighted Poster | 30 MB | 31,457,280 | 1 หน้า |

รับ PDF หนึ่งไฟล์ ไม่ตั้งรหัสผ่าน ขนาดเท่ากับเพดานรับได้ แต่ยังต้องผ่านการตรวจไฟล์และสิทธิ์อื่นตามระบบ

คำว่า `MB` เป็นป้ายแสดงผลตามที่อนุมัติ โดยคงเพดาน bytes และการแปลงขนาดด้วย `1024 * 1024` เดิม ไม่ได้เปลี่ยนเพดานเป็น 50,000,000 / 30,000,000 bytes กำหนดขนาดในโค้ด ไม่ใช้ ENV

## จุดกำหนดและตรวจสอบ

เส้นทางด้านล่างอ้างอิงจากโฟลเดอร์ `conference` เลขบรรทัดอาจเปลี่ยนเมื่อแก้โค้ด

| ไฟล์ | บรรทัด | หน้าที่ |
| --- | ---: | --- |
| `conference-api/src/modules/presentations/policy.ts` | 6–9 | ค่าหลัก `MAX_ORAL_BYTES`, `MAX_POSTER_BYTES` และเลือกเพดานด้วย `maxPresentationBytes(type)` |
| `conference-api/src/modules/presentations/public.routes.ts` | 18–22 | จำกัดขนาดระหว่างอ่าน multipart และตรวจไฟล์ที่ถูกตัดเพราะเกินขนาด |
| `conference-api/src/modules/presentations/file-validation.ts` | 9 | ตรวจขนาด Buffer ก่อนตรวจ PDF; เกินเพดานตอบ `PRESENTATION_FILE_TOO_LARGE` / HTTP 413 |
| `conference-api/src/modules/presentations/uploads.ts` | 133 | ตรวจขนาดซ้ำกับประเภทผลงานก่อนบันทึก |
| `Pris2026/src/lib/presentationLimits.ts` | 2–7 | ค่ากลาง Frontend; กำหนด 50 / 30 ครั้งเดียวและคำนวณ bytes |
| `Pris2026/src/lib/presentationSubmissionState.ts` | 6 | ตรวจ `file.size` ด้วยค่ากลางก่อนส่ง; เกินเพดานคืน `PRESENTATION_FILE_TOO_LARGE` |
| `Pris2026/src/components/presentations/PresentationWorkspace.tsx` | 16 | อ่าน `maxMB` จากค่ากลางสำหรับข้อกำหนด ข้อผิดพลาด และข้อความแสดงขนาด |
| `Pris2026/messages/th.json`, `Pris2026/messages/en.json` | 1298–1299 | ข้อความ `requirementsOral` และ `requirementsPoster` รับตัวแปร `{maxMB}` |

API เป็นตัวบังคับขนาดจริง การตรวจหน้าเว็บช่วยแจ้งผู้ใช้ก่อนอัปโหลด Highlighted Poster ใช้เพดาน Poster ร่วมกัน

## โค้ดที่เกี่ยวข้อง

คัดเฉพาะส่วนเกี่ยวข้องจากโค้ดปัจจุบัน โค้ดแต่ละส่วนอยู่ในไฟล์ที่ระบุ ไม่ใช่โปรแกรมแยกสำหรับรัน

### 1. ค่าหลักฝั่ง API

`conference-api/src/modules/presentations/policy.ts`

```ts
export type AbstractPresentationType = 'oral' | 'poster';
export const MAX_ORAL_BYTES = 52_428_800;
export const MAX_POSTER_BYTES = 31_457_280;
export const maxPresentationBytes = (type: AbstractPresentationType) => type === 'oral' ? MAX_ORAL_BYTES : MAX_POSTER_BYTES;
```

เลือกเพดานตามประเภท Oral; ประเภท Poster ใช้ 30 MB รวม Highlighted Poster ที่ระบบจัดสิทธิ์เป็น Poster

### 2. จำกัดขนาดขณะรับ multipart

`conference-api/src/modules/presentations/public.routes.ts`

```ts
async function readPresentationMultipart(request:FastifyRequest,type:AbstractPresentationType){
 let file:{buffer:Buffer;filename:string;mimetype:string}|undefined;let requestId:string|null=null;
 for await(const part of request.parts({limits:{files:1,fields:1,parts:2,fileSize:maxPresentationBytes(type)}})){
  if(part.type==='file'){
   if(part.fieldname!=='file'||file)fail('PRESENTATION_ONE_FILE_REQUIRED',422);
   file={buffer:await part.toBuffer(),filename:part.filename,mimetype:part.mimetype};
   if(part.file.truncated)fail('PRESENTATION_FILE_TOO_LARGE',413);
  }else{if(part.fieldname!=='requestId'||requestId!==null||typeof part.value!=='string')fail('PRESENTATION_INVALID_FIELDS',422);
   requestId=z.string().uuid().parse(part.value);}
 }
 if(!file)fail('PRESENTATION_ONE_FILE_REQUIRED',422);return {file:file!,requestId};
}
```

`fileSize` จำกัดขนาดของไฟล์ ไม่ใช่ขนาดรวม request; รับหนึ่งไฟล์และช่อง `requestId` ได้หนึ่งช่อง

### 3. ตรวจขนาดและจำนวนหน้า PDF

`conference-api/src/modules/presentations/file-validation.ts` — สองช่วงจากฟังก์ชัน `validatePresentationFile`

```ts
const { buffer, filename, mimetype } = file;
if (!buffer.length) fail('PRESENTATION_FILE_INVALID', 422);
if (buffer.length > maxPresentationBytes(type)) fail('PRESENTATION_FILE_TOO_LARGE', 413);
```

หลังอ่านจำนวนหน้าจาก PDF:

```ts
if (type === 'oral' ? pageCount < 2 : pageCount !== 1) fail('PRESENTATION_PDF_PAGE_COUNT', 422);
```

ขนาดเท่าเพดานผ่านการตรวจขนาด เพราะใช้ `>`; Oral ไม่ตรวจเพดานจำนวนหน้าสูงสุด

### 4. ตรวจซ้ำก่อนบันทึก

`conference-api/src/modules/presentations/uploads.ts`

```ts
const gate = await readUploadGate(tx, actor, abstractId, requestId);
if (a.storage_provider !== presentationStorageProvider(gate.presentationType) || file.presentationType !== gate.presentationType ||
  file.sizeBytes > maxPresentationBytes(gate.presentationType) || (gate.presentationType === 'oral' ? file.pageCount < 2 : file.pageCount !== 1)) fail('PRESENTATION_ROSTER_CONFLICT');
```

เทียบไฟล์กับประเภทผลงานและสิทธิ์ล่าสุดใน transaction ก่อนบันทึก

### 5. ตรวจไฟล์ที่เลือกบนหน้าเว็บ

`Pris2026/src/lib/presentationSubmissionState.ts`

ค่าที่ใช้มาจาก `Pris2026/src/lib/presentationLimits.ts`:

```ts
// MB is the display label; retain the approved 1024-based byte ceilings.
export const PRESENTATION_SIZE_UNIT_BYTES = 1024 * 1024;
const oralMB = 50, posterMB = 30;
export const PRESENTATION_LIMITS = {
  oral: { mb: oralMB, bytes: oralMB * PRESENTATION_SIZE_UNIT_BYTES },
  poster: { mb: posterMB, bytes: posterMB * PRESENTATION_SIZE_UNIT_BYTES },
} as const;
```

ฟังก์ชันตรวจไฟล์:

```ts
import { PRESENTATION_LIMITS } from './presentationLimits';

export function fileProblem(file: File, type: AnnouncementType): string | null {
  if (file.size < 1) return 'PRESENTATION_FILE_EMPTY';
  if (file.size > PRESENTATION_LIMITS[type === 'oral' ? 'oral' : 'poster'].bytes) return 'PRESENTATION_FILE_TOO_LARGE';
  const extension = /\.pdf$/i.test(file.name);
  const mime = file.type.toLowerCase();
  return extension && ['', 'application/octet-stream', 'application/pdf'].includes(mime)
    ? null : 'PRESENTATION_FILE_TYPE';
}
```

Frontend อ่านค่าจากไฟล์เดียวกัน แต่ยังแยกจาก API จึงต้องแก้ค่ากลางทั้งสอง repo เมื่อเปลี่ยนเพดาน

### 6. แสดงขนาดบนหน้าอัปโหลด

`Pris2026/src/components/presentations/PresentationWorkspace.tsx`

```ts
import { PRESENTATION_LIMITS, PRESENTATION_SIZE_UNIT_BYTES } from '@/lib/presentationLimits';

const oral = o.presentationType === 'oral';
const maxMB = PRESENTATION_LIMITS[oral ? 'oral' : 'poster'].mb;
const pageRule = t(oral ? 'pageRuleOral' : 'pageRulePoster');
```

`maxMB` ใช้แสดง `PDF · 50 MB` / `PDF · 30 MB` และเติมตัวเลขในข้อความผิดพลาดและข้อกำหนดด้วย `t(oral ? 'requirementsOral' : 'requirementsPoster', { maxMB })` ขนาดไฟล์ที่เลือกคำนวณด้วย `(p.file.size / PRESENTATION_SIZE_UNIT_BYTES).toFixed(2)`

`Pris2026/messages/th.json`

```json
{
  "requirementsOral": "ไฟล์ PDF หนึ่งไฟล์ อย่างน้อย 2 หน้า ขนาดไม่เกิน {maxMB} MB และไม่ตั้งรหัสผ่าน",
  "requirementsPoster": "ไฟล์ PDF หนึ่งไฟล์ หนึ่งหน้า ขนาดไม่เกิน {maxMB} MB และไม่ตั้งรหัสผ่าน"
}
```

`Pris2026/messages/en.json`

```json
{
  "requirementsOral": "One PDF file, at least 2 pages, maximum {maxMB} MB, without password protection.",
  "requirementsPoster": "One PDF file, exactly 1 page, maximum {maxMB} MB, without password protection."
}
```

### 7. ข้อกำหนดในอีเมล

`conference-api/src/modules/presentations/email-template.ts` — คำนวณจากค่าหลัก API

```ts
import { maxPresentationBytes } from './policy.js';
const maxMB = maxPresentationBytes(oral ? 'oral' : 'poster') / (1024 * 1024);
```

ส่วน HTML ภายใน template literal:

```ts
<li>ไฟล์ PDF จำนวนหนึ่งไฟล์ ${oral ? 'อย่างน้อย 2 หน้า' : 'หนึ่งหน้า'} ขนาดไม่เกิน ${maxMB} MB</li>
```

ข้อความอีเมลอ่านขนาดจาก policy อัตโนมัติ รวม initial / reminder / revision; receipt ใช้รูปแบบยืนยันรับไฟล์เดิม

## หากเปลี่ยนขนาดในอนาคต

1. เปลี่ยนค่าหลักใน `policy.ts` — จุดตรวจ API เรียกค่าผ่าน helper เดิม
2. เปลี่ยนค่ากลางใน `Pris2026/src/lib/presentationLimits.ts` ให้ตรงกัน
3. ข้อความข้อกำหนด/ข้อผิดพลาด Frontend และอีเมลรับค่าขนาดอัตโนมัติ ไม่ต้องแก้ตัวเลขในข้อความแปลหรือ template
4. อัปเดตค่าคาดหมายใน tests เมื่อเปลี่ยนกติกา แล้วทดสอบไฟล์ขนาดเท่าเพดานและเกินเพดานสำหรับทั้งสามประเภท

ไม่ต้องเพิ่มหรือแก้ ENV เพื่อเปลี่ยนขนาดไฟล์
