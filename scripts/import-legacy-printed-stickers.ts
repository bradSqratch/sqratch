import { loadEnvConfig } from "@next/env";
import * as XLSX from "xlsx";

loadEnvConfig(process.cwd());

const COLUMN_CONFIG: Record<
  number,
  {
    label: string;
    batchId: string;
    campaignId: string;
  }
> = {
  0: {
    label: "A",
    batchId: "legacy_col_a_demo_reserved",
    campaignId: "cmg17x35o0001y1huqg83zy6s",
  },
  1: {
    label: "B",
    batchId: "legacy_col_b_demo_reserved",
    campaignId: "cmg17x35o0001y1huqg83zy6s",
  },
  2: {
    label: "C",
    batchId: "legacy_col_c_max_moore",
    campaignId: "cmej566xx0001jx043tbout46",
  },
  3: {
    label: "D",
    batchId: "legacy_col_d_madeline_pearl",
    campaignId: "cmoatpoj70002lay192i4hgz7",
  },
  4: {
    label: "E",
    batchId: "legacy_col_e_demo_reserved",
    campaignId: "cmg17x35o0001y1huqg83zy6s",
  },
  5: {
    label: "F",
    batchId: "legacy_col_f_max_moore",
    campaignId: "cmej566xx0001jx043tbout46",
  },
};

type ParsedQr = {
  column: string;
  rowNumber: number;
  rawUrl: string;
  qrCodeData: string;
  campaignId: string;
  batchId: string;
};

function getArg(name: string) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function extractQrCodeData(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.at(-1) || null;
  } catch {
    // fallback if a cell contains only the raw qrCodeData
    return value;
  }
}

async function main() {
  const { default: prisma } = await import("../src/lib/prisma");

  try {
    const filePath = getArg("file");
    const apply = process.argv.includes("--apply");
    const dryRun = !apply;

    if (!filePath) {
      throw new Error(
        `Missing file path. Usage: npx tsx scripts/import-legacy-printed-stickers.ts --file="/path/to/file.xlsx" --dry-run`,
      );
    }

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      throw new Error("No sheet found in workbook.");
    }

    const sheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
    });

    const parsed: ParsedQr[] = [];
    const invalidCells: Array<{
      column: string;
      rowNumber: number;
      value: unknown;
    }> = [];

    rows.forEach((row, rowIndex) => {
      for (const [colIndexRaw, config] of Object.entries(COLUMN_CONFIG)) {
        const colIndex = Number(colIndexRaw);
        const rawValue = row[colIndex];
        const qrCodeData = extractQrCodeData(rawValue);

        if (!qrCodeData) {
          invalidCells.push({
            column: config.label,
            rowNumber: rowIndex + 1,
            value: rawValue,
          });
          continue;
        }

        parsed.push({
          column: config.label,
          rowNumber: rowIndex + 1,
          rawUrl: String(rawValue).trim(),
          qrCodeData,
          campaignId: config.campaignId,
          batchId: config.batchId,
        });
      }
    });

    const seen = new Map<string, ParsedQr>();
    const duplicates: Array<{ first: ParsedQr; duplicate: ParsedQr }> = [];

    for (const item of parsed) {
      const existing = seen.get(item.qrCodeData);
      if (existing) {
        duplicates.push({ first: existing, duplicate: item });
      } else {
        seen.set(item.qrCodeData, item);
      }
    }

    const uniqueItems = Array.from(seen.values());

    console.log("Sheet:", sheetName);
    console.log("Rows detected:", rows.length);
    console.log("Parsed QR cells:", parsed.length);
    console.log("Unique QR codes:", uniqueItems.length);
    console.log("Invalid/blank cells:", invalidCells.length);
    console.log("Duplicate QR codes in Excel:", duplicates.length);
    console.log("Mode:", dryRun ? "DRY RUN" : "APPLY");

    const byColumn = uniqueItems.reduce<Record<string, number>>((acc, item) => {
      acc[item.column] = (acc[item.column] || 0) + 1;
      return acc;
    }, {});

    console.log("Counts by column:", byColumn);

    if (invalidCells.length > 0) {
      console.log("First invalid cells:", invalidCells.slice(0, 10));
    }

    if (duplicates.length > 0) {
      console.error("Duplicate examples:", duplicates.slice(0, 10));
      throw new Error("Stop. Duplicate qrCodeData values found in Excel.");
    }

    const qrCodeValues = uniqueItems.map((item) => item.qrCodeData);

    const existing = await prisma.qRCode.findMany({
      where: {
        qrCodeData: {
          in: qrCodeValues,
        },
      },
      select: {
        qrCodeData: true,
        campaignId: true,
        batchId: true,
        status: true,
        isActive: true,
      },
    });

    const existingMap = new Map(
      existing.map((item) => [
        item.qrCodeData,
        {
          campaignId: item.campaignId,
          batchId: item.batchId,
          status: item.status,
          isActive: item.isActive,
        },
      ]),
    );

    const missing = uniqueItems.filter(
      (item) => !existingMap.has(item.qrCodeData),
    );

    const toUpdate = uniqueItems.filter((item) => {
      const current = existingMap.get(item.qrCodeData);

      if (!current) return false;

      return (
        current.campaignId !== item.campaignId ||
        current.batchId !== item.batchId
      );
    });

    const alreadyCorrect =
      uniqueItems.length - missing.length - toUpdate.length;

    console.log("Existing QR codes found in DB:", existing.length);
    console.log("Missing QR codes not found in DB:", missing.length);
    console.log("Already correctly assigned:", alreadyCorrect);
    console.log("QR codes that still need update:", toUpdate.length);

    if (missing.length > 0) {
      console.log("First missing QR codes:", missing.slice(0, 20));
    }

    if (dryRun) {
      console.log("Dry run complete. No DB changes made.");
      return;
    }

    const grouped = new Map<
      string,
      {
        campaignId: string;
        batchId: string;
        qrCodeData: string[];
      }
    >();

    for (const item of toUpdate) {
      const key = `${item.campaignId}::${item.batchId}`;

      const group = grouped.get(key) || {
        campaignId: item.campaignId,
        batchId: item.batchId,
        qrCodeData: [],
      };

      group.qrCodeData.push(item.qrCodeData);
      grouped.set(key, group);
    }

    const chunkSize = 500;
    let updated = 0;

    for (const group of grouped.values()) {
      for (let i = 0; i < group.qrCodeData.length; i += chunkSize) {
        const chunk = group.qrCodeData.slice(i, i + chunkSize);

        const result = await prisma.$executeRawUnsafe(
          `
        UPDATE "QRCode"
        SET
          "campaignId" = $1,
          "batchId" = $2,
          "updatedAt" = NOW()
        WHERE "qrCodeData" = ANY($3::text[])
          AND (
            "campaignId" <> $1
            OR "batchId" IS DISTINCT FROM $2
          )
      `,
          group.campaignId,
          group.batchId,
          chunk,
        );

        updated += Number(result);

        console.log(
          `Updated ${updated}/${toUpdate.length} | batch=${group.batchId}`,
        );
      }
    }

    console.log("Import completed.");
    console.log("Total updated:", updated);
    console.log("Missing skipped:", missing.length);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
