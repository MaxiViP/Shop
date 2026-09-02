<template>
  <UModal
    v-model:open="open"
    :title="title"
    description="Адрес будет доступен при оформлении заказа."
    :ui="{
      content: 'w-[calc(100%-2rem)] max-w-2xl max-h-[calc(100dvh-2rem)]',
      body: 'overflow-y-auto',
    }"
  >
    <template #body>
      <form
        class="form"
        @submit.prevent="save"
      >
        <UFormField label="Название">
          <UInput
            v-model="form.label"
            placeholder="Дом"
            maxlength="30"
            size="lg"
            autofocus
          />
        </UFormField>

        <div class="form__row">
          <UFormField label="Город">
            <UInput
              v-model="form.city"
              placeholder="Москва"
              size="lg"
            />
          </UFormField>

          <UFormField label="Улица">
            <UInput
              v-model="form.street"
              placeholder="Ленинский проспект"
              size="lg"
            />
          </UFormField>
        </div>

        <div class="form__row form__row--small">
          <UFormField label="Дом">
            <UInput
              v-model="form.house"
              placeholder="53"
              size="lg"
            />
          </UFormField>

          <UFormField label="Квартира">
            <UInput
              v-model="form.flat"
              placeholder="25"
              size="lg"
            />
          </UFormField>

          <UFormField label="Подъезд">
            <UInput
              v-model="form.entrance"
              placeholder="2"
              size="lg"
            />
          </UFormField>

          <UFormField label="Этаж">
            <UInput
              v-model="form.floor"
              placeholder="7"
              size="lg"
            />
          </UFormField>
        </div>

        <UFormField label="Домофон">
          <UInput
            v-model="form.intercom"
            placeholder="25К"
            size="lg"
          />
        </UFormField>

        <UFormField label="Комментарий курьеру">
          <UTextarea
            v-model="form.comment"
            placeholder="Позвонить за 10 минут"
            :rows="3"
            maxlength="300"
            size="lg"
          />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          :description="error"
        />

        <div class="form__actions">
          <UButton
            type="button"
            variant="ghost"
            color="neutral"
            @click="open = false"
          >
            Отмена
          </UButton>

          <UButton
            type="submit"
            :loading="loading"
          >
            Сохранить
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { Address } from '~/types/address'

const props = defineProps<{
  address?: Address | null
}>()

const emit = defineEmits<{
  saved: []
}>()

const open = defineModel<boolean>('open', {
  required: true,
})

const api = useApiClient()
const toast = useToast()

const loading = ref(false)
const error = ref('')

const form = reactive({
  label: '',
  city: 'Москва',
  street: '',
  house: '',
  flat: '',
  entrance: '',
  floor: '',
  intercom: '',
  comment: '',
})

const title = computed(() =>
  props.address
    ? 'Изменить адрес'
    : 'Новый адрес',
)

watch(
  () => open.value,
  value => {
    if (value) {
      fill()
    }
  },
)

function fill() {
  const address = props.address

  form.label = address?.label ?? ''
  form.city = address?.city ?? 'Москва'
  form.street = address?.street ?? ''
  form.house = address?.house ?? ''
  form.flat = address?.flat ?? ''
  form.entrance = address?.entrance ?? ''
  form.floor = address?.floor ?? ''
  form.intercom = address?.intercom ?? ''
  form.comment = address?.comment ?? ''

  error.value = ''
}

async function save() {
  if (
    !form.label.trim()
    || !form.city.trim()
    || !form.street.trim()
    || !form.house.trim()
  ) {
    error.value =
      'Заполните название, город, улицу и дом'

    return
  }

  loading.value = true
  error.value = ''

  const body = {
    label: form.label,
    city: form.city,
    street: form.street,
    house: form.house,

    flat: form.flat || undefined,
    entrance: form.entrance || undefined,
    floor: form.floor || undefined,
    intercom: form.intercom || undefined,
    comment: form.comment || undefined,
  }

  try {
    if (props.address) {
      await api(`/addresses/${props.address.id}`, {
        method: 'PATCH',
        body,
      })
    } else {
      await api('/addresses', {
        method: 'POST',
        body,
      })
    }

    toast.add({
      title: props.address
        ? 'Адрес изменён'
        : 'Адрес добавлен',
    })

    open.value = false

    emit('saved')
  } catch {
    error.value =
      'Не удалось сохранить адрес'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.form {
  display: grid;
  gap: 1rem;
}

.form__row {
  display: grid;
  gap: 1rem;
}

.form__actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.form__actions > * {
  min-height: var(--touch-target);
  flex: 1;
  justify-content: center;
}

.form :deep(input),
.form :deep(textarea) {
  font-size: 1rem;
}

@media (min-width: 40rem) {
  .form__row {
    grid-template-columns: 11.25rem minmax(0, 1fr);
  }

  .form__row--small {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .form__actions {
    justify-content: flex-end;
  }

  .form__actions > * {
    flex: 0 0 auto;
  }
}
</style>
