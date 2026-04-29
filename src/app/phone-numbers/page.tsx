import { Phone, Shield, BarChart3, RefreshCw, Construction } from "lucide-react";

const PLANNED_FEATURES = [
  {
    icon: Phone,
    title: "Caller ID Management",
    description:
      "View and configure the outbound phone numbers your campaigns dial from. Assign specific caller IDs to different campaigns.",
    color: "blue",
  },
  {
    icon: RefreshCw,
    title: "Number Pools & Rotation",
    description:
      "Rotate through multiple caller IDs automatically to maintain healthy call delivery rates and reduce spam flagging.",
    color: "indigo",
  },
  {
    icon: Shield,
    title: "STIR/SHAKEN & Spam Status",
    description:
      "Monitor attestation levels and carrier spam scores for each number. Get alerts when a number needs attention.",
    color: "emerald",
  },
  {
    icon: BarChart3,
    title: "Per-Number Analytics",
    description:
      "Track connect rates, answer rates, and call duration per caller ID to identify your best-performing numbers.",
    color: "amber",
  },
];

const COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  blue:    { bg: "bg-blue-500/10",    border: "border-blue-500/20",    text: "text-blue-400"    },
  indigo:  { bg: "bg-indigo-500/10",  border: "border-indigo-500/20",  text: "text-indigo-400"  },
  emerald: { bg: "bg-emerald-500/10", border: "border-emerald-500/20", text: "text-emerald-400" },
  amber:   { bg: "bg-amber-500/10",   border: "border-amber-500/20",   text: "text-amber-400"   },
};

export default function PhoneNumbersPage() {
  return (
    <div className="p-4 sm:p-6 w-full max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
          <Phone size={17} className="text-blue-400" />
        </div>
        <h1 className="text-lg sm:text-xl font-bold text-[var(--text-1)]">Phone Numbers</h1>
      </div>
      <p className="text-sm text-[var(--text-2)] mb-8 ml-12">
        Manage the outbound caller IDs your campaigns dial from.
      </p>

      {/* Coming soon banner */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5 sm:p-6 mb-8">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Construction size={17} className="text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-1)] mb-1">Coming Soon</h2>
            <p className="text-sm text-[var(--text-2)] leading-relaxed">
              Phone number management is currently handled at the infrastructure level.
              This page will give you direct control over your outbound numbers, pools,
              and health monitoring — no server access needed.
            </p>
            <p className="text-xs text-[var(--text-3)] mt-2">
              Right now, all campaigns use a single caller ID configured in the FreeSWITCH dialplan.
            </p>
          </div>
        </div>
      </div>

      {/* Planned features grid */}
      <h3 className="text-xs font-semibold text-[var(--text-3)] uppercase tracking-wide mb-4">
        Planned Features
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PLANNED_FEATURES.map((feature) => {
          const c = COLOR_MAP[feature.color];
          const Icon = feature.icon;
          return (
            <div
              key={feature.title}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 hover:border-[var(--border-2)] transition-colors"
            >
              <div className="flex items-center gap-2.5 mb-2">
                <div
                  className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${c.bg} border ${c.border}`}
                >
                  <Icon size={14} className={c.text} />
                </div>
                <h4 className="text-sm font-semibold text-[var(--text-1)]">
                  {feature.title}
                </h4>
              </div>
              <p className="text-xs text-[var(--text-2)] leading-relaxed">
                {feature.description}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
