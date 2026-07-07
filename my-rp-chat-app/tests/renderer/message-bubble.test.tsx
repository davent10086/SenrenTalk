// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../src/renderer/components/MessageBubble";
import { createChatMessage } from "../helpers/factories";

describe("MessageBubble", () => {
  it("asks for confirmation before edit-and-regenerate", async () => {
    const onEditAndRegenerate = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <MessageBubble
        message={createChatMessage({ id: "msg-1", content: "旧内容" })}
        mediaUrls={{}}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑后重生成" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重生成" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(onEditAndRegenerate).not.toHaveBeenCalled();
  });
});
