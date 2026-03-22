import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Puzzle, LogIn, Globe, Moon, Sun, User } from 'lucide-react';

export function UserMenu() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleDarkMode = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
  };

  const toggleLanguage = () => {
    const next = i18n.language === 'pt-BR' ? 'en' : 'pt-BR';
    i18n.changeLanguage(next);
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <User size={16} />
        <span className="hidden sm:inline">User</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-popover border border-border rounded-md shadow-lg z-50 py-1">
          <button disabled className="w-full flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground cursor-not-allowed">
            <Settings size={14} />
            {t('user_menu.settings')}
          </button>
          <button disabled className="w-full flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground cursor-not-allowed">
            <Puzzle size={14} />
            {t('user_menu.plugins')}
          </button>
          <button disabled className="w-full flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground cursor-not-allowed">
            <LogIn size={14} />
            {t('user_menu.login')}
          </button>

          <div className="border-t border-border my-1" />

          <button
            onClick={toggleDarkMode}
            className="w-full flex items-center justify-between px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
          >
            <span className="flex items-center gap-3">
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
              {t('user_menu.dark_mode')}
            </span>
            <span className="text-xs text-muted-foreground">{isDark ? 'ON' : 'OFF'}</span>
          </button>

          <button
            onClick={toggleLanguage}
            className="w-full flex items-center justify-between px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
          >
            <span className="flex items-center gap-3">
              <Globe size={14} />
              {t('user_menu.language')}
            </span>
            <span className="text-xs text-muted-foreground">{i18n.language === 'pt-BR' ? 'PT' : 'EN'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
