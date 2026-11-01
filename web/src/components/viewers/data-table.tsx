"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { useFindId, useFindSource } from "@/components/find/use-find-source";
import { lineAtViewportTop, topInset } from "@/lib/find/skip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Row = string[];

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
const helper = createColumnHelper<typeof features, Row>();

/** Sortable table of string cells (CSV / xlsx preview). */
export function DataTable({ header, rows }: { header: string[]; rows: Row[] }) {
  const width = Math.max(header.length, ...rows.slice(0, 200).map((r) => r.length));
  const columns = useMemo(
    () =>
      helper.columns(
        Array.from({ length: width }, (_, i) =>
          helper.accessor((row: Row) => row[i] ?? "", {
            id: `c${i}`,
            header: header[i] || `Column ${i + 1}`,
            sortFn: "alphanumeric",
          }),
        ),
      ),
    [header, width],
  );
  const table = useTable({ features, columns, data: rows });
  const display = table.getRowModel().rows;

  // Find in the file (components/find/): every cell in display order (all rows are rendered;
  // the server caps how many), header first; a new order (sorting) or data is a new text.
  const ref = useRef<HTMLDivElement>(null);
  const findId = useFindId();
  const labels = useMemo(() => Array.from({ length: width }, (_, i) => header[i] || `Column ${i + 1}`), [header, width]);
  const findData = useRef({ display, labels, version: 0 });
  const findChanged = useFindSource(
    () => ({
      kind: "cells",
      root: () => ref.current,
      key: () => `${findId}:${findData.current.version}`,
      rows: () => {
        const d = findData.current;
        return { rows: [d.labels, ...d.display.map((r) => r.original)], width };
      },
      cells: (root) => {
        // indexed once: a selector per matched cell is a full-table scan each
        const trs = root.querySelectorAll<HTMLElement>("tbody tr[data-row]");
        let ths: NodeListOf<HTMLElement> | null = null;
        return (row, col) => {
          if (row === 0) {
            ths ??= root.querySelectorAll<HTMLElement>("thead th[data-col]");
            return ths[col]?.querySelector<HTMLElement>("[data-find-text]") ?? null;
          }
          const tr = trs[row - 1];
          // the first cell is the row number
          return tr?.dataset.row === String(row) ? ((tr.children[col + 1] as HTMLElement | undefined) ?? null) : null;
        };
      },
      rowAtTop: (root) => {
        const el = lineAtViewportTop(root, "tbody tr[data-row]") as HTMLElement | null;
        const row = el ? Number(el.dataset.row) : null;
        // at the top of the table with its header in view: the header (row 0) comes first
        if (row === 1 || row === null) {
          const hr = root.querySelector("thead")?.getBoundingClientRect();
          if (hr && hr.bottom > topInset(false) && hr.top < window.innerHeight) return 0;
        }
        return row;
      },
    }),
    [findId, width],
  );
  useEffect(() => {
    const d = findData.current;
    if (d.display === display && d.labels === labels) return;
    findData.current = { display, labels, version: d.version + 1 };
    findChanged();
  }, [display, labels, findChanged]);

  return (
    <div ref={ref} className="overflow-auto rounded-lg border">
      <Table className="text-[13px]">
        <TableHeader className="sticky top-0 z-[1] bg-muted/80 backdrop-blur">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              <TableHead className="w-10 text-right text-muted-foreground">#</TableHead>
              {group.headers.map((h, col) => {
                const sorted = h.column.getIsSorted();
                return (
                  <TableHead key={h.id} className="whitespace-nowrap" data-col={col}>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                      onClick={h.column.getToggleSortingHandler()}
                    >
                      <span data-find-text>
                        <table.FlexRender header={h} />
                      </span>
                      {sorted === "asc" ? (
                        <ArrowUpIcon className="size-3.5" />
                      ) : sorted === "desc" ? (
                        <ArrowDownIcon className="size-3.5" />
                      ) : (
                        <ArrowUpDownIcon className="size-3.5 opacity-40" />
                      )}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {display.map((row, i) => (
            <TableRow key={row.id} data-row={i + 1}>
              <TableCell className="text-right text-muted-foreground tabular-nums">{row.index + 1}</TableCell>
              {row.getAllCells().map((cell, col) => (
                <TableCell key={cell.id} data-col={col} className={cn("max-w-[32rem] truncate align-top")} title={String(cell.getValue() ?? "")}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
