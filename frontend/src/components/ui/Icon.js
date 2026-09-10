import React from 'react';
import {
  LayoutDashboard,
  BarChart3,
  TrendingUp,
  Bookmark,
  Settings,
  UserRound,
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  LogOut,
  Wallet,
  Eye,
  MousePointerClick,
  Percent,
  CircleDollarSign,
  PiggyBank,
  Smartphone,
  Globe2,
  Users,
  Megaphone,
  MapPin,
  CalendarDays,
  ArrowUpRight,
  ArrowDownRight,
  ShieldAlert,
  Inbox,
  User,
  Lock,
  Network,
  LayoutGrid,
} from 'lucide-react';

const NAV_ICONS = {
  dashboard: LayoutDashboard,
  reporting: BarChart3,
  roi: TrendingUp,
  presets: Bookmark,
  admin: Settings,
  'domain-user': UserRound,
  'my-ads': Megaphone,
};

const FILTER_ICONS = {
  accounts: Users,
  campaigns: Megaphone,
  apps: Smartphone,
  sites: Globe2,
  countries: MapPin,
  calendar: CalendarDays,
  domain: Network,
  adunit: LayoutGrid,
};

const KPI_ICONS = {
  spend: Wallet,
  impressions: Eye,
  clicks: MousePointerClick,
  ctr: Percent,
  ecpm: CircleDollarSign,
  earn: PiggyBank,
  profitSpend: TrendingUp,
  roiSpend: Percent,
  app: Smartphone,
  site: Globe2,
  total: CircleDollarSign,
  revenue: CircleDollarSign,
  viewability: Eye,
};

const EMPTY_ICONS = {
  empty: Inbox,
  inbox: Inbox,
};

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.75,
  className = '',
  ...rest
}) {
  const Cmp = NAV_ICONS[name]
    || FILTER_ICONS[name]
    || KPI_ICONS[name]
    || EMPTY_ICONS[name]
    || null;
  if (!Cmp) return null;
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      className={`ui-icon ${className}`.trim()}
      aria-hidden
      {...rest}
    />
  );
}

export function NavIcon({ page, size = 18 }) {
  return <Icon name={page} size={size} />;
}

export function FilterIcon({ name, size = 18 }) {
  return <Icon name={name} size={size} />;
}

/** Small icon chip for stacked filter labels (Dashboard / Reporting grids). */
export function FilterFieldIcon({ name, size = 14 }) {
  return (
    <span className="filter-field-icon" aria-hidden>
      <Icon name={name} size={size} />
    </span>
  );
}

export function KpiIcon({ name, size = 14 }) {
  return <Icon name={name} size={size} className="roi-kpi-icon" />;
}

export function EmptyIcon({ size = 40 }) {
  return <Icon name="empty" size={size} className="ui-empty-icon" />;
}

export {
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  LogOut,
  Smartphone,
  Globe2,
  ArrowUpRight,
  ArrowDownRight,
  ShieldAlert,
  LayoutDashboard,
  BarChart3,
  TrendingUp,
  Bookmark,
  Settings,
  UserRound,
  Inbox,
  User,
  Lock,
  Users,
  Megaphone,
};
