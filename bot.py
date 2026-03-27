async def chat_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    bot_info = await context.bot.get_me()
    is_private = update.message.chat.type == constants.ChatType.PRIVATE
    is_tagged = f"@{bot_info.username}" in (update.message.text or "")
    
    if is_private or is_tagged:
        await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=constants.ChatAction.TYPING)
        user_text = update.message.text.replace(f"@{bot_info.username}", "").strip()
        try:
            print(f"👉 Đang gửi tới Gemini: {user_text}")
            response = model.generate_content(user_text)
            await update.message.reply_text(response.text)
        except Exception as e:
            print(f"❌ LỖI GEMINI: {e}")
            await update.message.reply_text(f"Lỗi rồi sếp: {str(e)[:100]}")
