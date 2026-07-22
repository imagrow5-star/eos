import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * Password input with a standard show/hide (eye) toggle.
 *
 * Drop-in replacement for `<input type="password" …>` — pass the exact same
 * props/classes. The toggle only flips the input's `type` locally; the value
 * is never copied anywhere, so autofill, form submission, and password
 * managers behave exactly as before.
 */
export function PasswordInput({ className, disabled, ...rest }: Props) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        {...rest}
        disabled={disabled}
        type={visible ? "text" : "password"}
        className={cn(className, "pr-11")}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40"
      >
        {visible ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
      </button>
    </div>
  );
}
