import {
  Bot,
  Code,
  Globe,
  Sparkles,
  FileText,
  Lightbulb,
  Briefcase,
  Search,
  User,
  Mail,
  Target,
  Rocket,
  Building2,
  ListChecks,
} from 'lucide-react';

// Icon 映射
// lucide-react 的图标是 ForwardRefExoticComponent，无法直接匹配简化的 ComponentType，故用 any 兼容
export const ICON_MAP: Record<string, React.ComponentType<any>> = {
  Bot,
  Sparkles,
  Code,
  FileText,
  Globe,
  Lightbulb,
  Briefcase,
  Search,
  User,
  Mail,
  Target,
  Rocket,
  Building2,
  ListChecks,
};
