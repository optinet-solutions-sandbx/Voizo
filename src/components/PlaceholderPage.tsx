interface PlaceholderPageProps {
  title: string;
  description?: string;
}

export default function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="p-4 sm:p-6 w-full flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-14 h-14 sm:w-16 sm:h-16 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex items-center justify-center mb-4">
        <span className="text-blue-400 text-2xl font-bold">{title[0]}</span>
      </div>
      <h1 className="text-xl sm:text-2xl font-bold text-[var(--text-1)] mb-2">{title}</h1>
      <p className="text-[var(--text-2)] text-sm max-w-xs leading-relaxed">
        {description ?? "This section is coming soon."}
      </p>
    </div>
  );
}
