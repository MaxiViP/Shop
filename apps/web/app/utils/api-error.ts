interface ErrorData {
  message?: unknown
}

interface ApiError {
  data?: unknown
  message?: unknown
}

export function apiError(error: unknown) {
  if (typeof error !== 'object' || error === null) {
    return 'Не удалось выполнить действие'
  }

  const value = error as ApiError

  if (typeof value.data === 'object' && value.data !== null) {
    const data = value.data as ErrorData

    if (typeof data.message === 'string') {
      return data.message
    }

    if (
      Array.isArray(data.message) &&
      data.message.every((message) => typeof message === 'string')
    ) {
      return data.message.join('. ')
    }
  }

  if (typeof value.message === 'string') {
    return value.message
  }

  return 'Не удалось выполнить действие'
}
