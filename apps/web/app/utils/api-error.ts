interface ErrorData {
  message?: unknown
}

interface ApiError {
  data?: unknown
  message?: unknown
}

const messages: Record<string, string> = {
  ACCOUNT_LINK_REQUIRED: "Этот номер или Telegram уже связан с другим аккаунтом, либо требуется смена номера. Для объединения аккаунтов или смены привязки нужен отдельный процесс подтверждения.",
  TELEGRAM_AUTH_INVALID: "Не удалось подтвердить вход через Telegram. Повторите вход или заново откройте мини-приложение.",
  TELEGRAM_AUTH_REPLAY: "Этот запрос входа уже использован. Закройте и заново откройте мини-приложение.",
  TELEGRAM_LOGIN_UNAVAILABLE: "Вход через Telegram пока недоступен. Можно продолжить без регистрации.",
}

export function apiError(error: unknown) {
  if (typeof error !== 'object' || error === null) {
    return 'Не удалось выполнить действие'
  }

  const value = error as ApiError

  if (typeof value.data === 'object' && value.data !== null) {
    const data = value.data as ErrorData

    if (typeof data.message === 'string') {
      return messages[data.message] ?? data.message
    }

    if (
      Array.isArray(data.message) &&
      data.message.every((message) => typeof message === 'string')
    ) {
      return data.message.map(message => messages[message] ?? message).join('. ')
    }
  }

  if (typeof value.message === 'string') {
    return messages[value.message] ?? value.message
  }

  return 'Не удалось выполнить действие'
}
