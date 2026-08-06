import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "./utils";

function PasswordInput({ className, type: _type, ...props }: React.ComponentProps<"input">) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        className={cn("pr-10", className)}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        onClick={() => setShow((v) => !v)}
      >
        {show ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

export { PasswordInput };
