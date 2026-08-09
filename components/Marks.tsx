type MarkProps = { className?: string };

export function BrainpodMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 19.89 21.47" className={className} aria-hidden>
      <path
        className="fill-current"
        d="M6.14451 14.0293C6.40601 10.6845 9.10699 7.98496 12.4518 7.72417C13.9056 7.61047 15.2721 7.95227 16.4275 8.6181C19.3971 3.77042 16.8525 0 11.8044 0H0.974935C0.436304 0 0 0.436305 0 0.974936V19.7588C0 20.2377 0.348192 20.6485 0.821449 20.7217C3.05485 21.0677 5.18734 20.5604 7.5785 18.8087C6.56306 17.5091 6.00382 15.8363 6.14451 14.0293Z"
      />
      <path
        className="fill-beam"
        d="M16.4282 8.61755C16.2939 8.83642 16.1497 9.05812 15.9926 9.28125C12.6742 13.9989 9.9938 17.0395 7.57849 18.8096C8.83767 20.422 10.7982 21.4601 13.0018 21.4601C16.8006 21.4601 19.8803 18.3804 19.8803 14.5816C19.8803 12.0305 18.4904 9.80567 16.4282 8.61755Z"
      />
    </svg>
  );
}

export function EuropeanFlag({ className }: MarkProps) {
  const ringRadius = 19;
  const starRadius = 4.4;

  return (
    <svg viewBox="0 0 60 60" className={className} aria-hidden>
      <rect width="60" height="60" fill="#003399" />
      {Array.from({ length: 12 }, (_, i) => {
        const angle = (i * 30 - 90) * (Math.PI / 180);
        const cx = 30 + ringRadius * Math.cos(angle);
        const cy = 30 + ringRadius * Math.sin(angle);
        const inner = starRadius * 0.381966;
        const points = Array.from({ length: 10 }, (_, j) => {
          const r = j % 2 === 0 ? starRadius : inner;
          const a = (-90 + j * 36) * (Math.PI / 180);
          return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
        }).join(" ");
        return <polygon key={i} points={points} fill="#ffcc00" />;
      })}
    </svg>
  );
}
