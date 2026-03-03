interface ProgressBarProps {
  done: number;
  total: number;
  className?: string;
}

export function ProgressBar({ done, total, className = "" }: ProgressBarProps) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex-1 bg-gray-700 rounded-full h-2 overflow-hidden">
        <div
          className="h-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">
        {done}/{total}
      </span>
    </div>
  );
}
