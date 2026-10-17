import type { ToolOutput } from "@eyes/core";
import { useToolContext } from "mcp-use/react";
import { useState } from "react";

const STATUS = {
  dispatched: ["Waiting for a worker", "bg-slate-100 text-slate-700", "Held"],
  claimed: ["A worker is on the way", "bg-sky-100 text-sky-800", "Held"],
  submitted: ["Answer in, checking it", "bg-sky-100 text-sky-800", "Held"],
  verified: ["Verified", "bg-emerald-100 text-emerald-800", "Cost"],
  paid: ["Verified and paid", "bg-emerald-100 text-emerald-800", "Cost"],
  needs_review: ["Needs a human review", "bg-amber-100 text-amber-900", "Held"],
  disputed: ["Disputed, under review", "bg-amber-100 text-amber-900", "Held"],
  expired: ["Expired, refunded", "bg-slate-100 text-slate-700", "Refunded"],
  refunded: ["Cancelled, refunded", "bg-slate-100 text-slate-700", "Refunded"],
} as const;

const usd = (amount: number) => `$${amount.toFixed(2)}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Photo({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <div className="flex h-24 items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">
        No photo to show
      </div>
    );
  }
  return (
    <img
      src={url}
      alt="Taken on site by the worker"
      className="h-56 w-full rounded-xl object-cover"
      onError={() => setBroken(true)}
    />
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex gap-2">
      <span className={ok ? "text-emerald-600" : "text-red-600"}>{ok ? "✓" : "✗"}</span>
      <span>
        {label}: {ok ? "passed" : "failed"}
      </span>
    </li>
  );
}

export default function TaskCard() {
  const view = useToolContext();
  if (view.status === "pending") return <p className="p-4 text-sm text-slate-500">Loading the task…</p>;
  if (view.status === "error") return <p className="p-4 text-sm text-red-700">{view.error.message}</p>;
  const task = view.toolOutput as ToolOutput<"get_task">;
  const [label, tone, money] = STATUS[task.status] ?? [task.status, STATUS.dispatched[1], "Held"];
  const answer = task.answer;
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white font-sans text-slate-900">
      <header className="flex items-center justify-between gap-3 bg-[#121820] px-4 py-3">
        <span className="flex items-center gap-2 font-bold text-[#eef3f8]">
          <span className="h-4 w-6 rounded-full bg-[radial-gradient(circle,#121820_0_28%,#ffc24b_30%)] shadow-[0_0_10px_rgba(255,194,75,0.45)]" />
          Eyes
        </span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>{label}</span>
      </header>
      <div className="space-y-4 p-4">
        <div>
          <p className="text-sm text-slate-500">{task.place_label}</p>
          <h1 className="text-lg leading-snug font-semibold">{task.question}</h1>
        </div>
        {answer ? (
          <>
            <Photo url={answer.photo_url} />
            <div>
              <p className="text-base font-medium">
                {answer.answer_bool === null ? "" : answer.answer_bool ? "Yes. " : "No. "}
                {answer.answer_text}
              </p>
              <p className="text-sm text-slate-500">
                Captured {time(answer.captured_at)}, {Math.round(answer.worker_distance_m)} m from the place,
                confidence {Math.round(answer.confidence * 100)}%
              </p>
            </div>
            <ul className="space-y-1 text-sm">
              <Check ok={answer.verification.gps_ok} label="Location matches the place" />
              <Check ok={answer.verification.fresh_ok} label="Photo taken in time" />
              <Check ok={answer.verification.vision_ok} label="Photo answers the question" />
            </ul>
            <p className="text-sm text-slate-500">{answer.verification.vision_reason}</p>
          </>
        ) : (
          <p className="text-sm text-slate-500">
            No answer yet. Workers can answer until {time(task.deadline_at)}.
          </p>
        )}
        <p className="border-t border-slate-200 pt-3 text-sm">
          {money}: <b>{usd(task.bounty_usd + task.fee_usd)}</b> (bounty {usd(task.bounty_usd)} plus fee{" "}
          {usd(task.fee_usd)})
        </p>
      </div>
    </article>
  );
}
