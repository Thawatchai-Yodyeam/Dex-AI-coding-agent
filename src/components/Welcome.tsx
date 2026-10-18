import React from 'react';
import { Search, TerminalSquare, Code2, ListChecks } from 'lucide-react';
import type { Translation } from '../utils/i18n';
import { DexMark } from './DexMark';

interface WelcomeProps {
  t: Translation;
  composer: React.ReactNode;
  onQuickPrompt: (prompt: string) => void;
}

function greeting(t: Translation): string {
  const h = new Date().getHours();
  if (h < 12) return t.greetingMorning;
  if (h < 18) return t.greetingAfternoon;
  return t.greetingEvening;
}

export const Welcome: React.FC<WelcomeProps> = ({ t, composer, onQuickPrompt }) => {
  const prompts = [
    { icon: Search, title: t.qpExploreTitle, prompt: t.qpExplorePrompt },
    { icon: TerminalSquare, title: t.qpSystemTitle, prompt: t.qpSystemPrompt },
    { icon: Code2, title: t.qpReviewTitle, prompt: t.qpReviewPrompt },
    { icon: ListChecks, title: t.qpTestTitle, prompt: t.qpTestPrompt },
  ];

  return (
    <div className="welcome">
      <h1 className="welcome-title">
        <DexMark size={34} />
        <span>{greeting(t)}</span>
      </h1>
      {composer}
      <div className="quick-prompts">
        {prompts.map(({ icon: Icon, title, prompt }) => (
          <button key={title} type="button" className="quick-prompt" onClick={() => onQuickPrompt(prompt)}>
            <Icon size={16} aria-hidden="true" />
            {title}
          </button>
        ))}
      </div>
    </div>
  );
};
