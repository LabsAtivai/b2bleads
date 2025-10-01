// services/help.js
import qs from 'qs';
import { get } from '@/api';

const controller = 'Natureza';

export async function FindAllNatureza(queryParams) {
  const http = await get();
  const queryString = queryParams
    ? qs.stringify(queryParams, {
        addQueryPrefix: true, // já põe "?"
        encode: false,
        allowDots: true,
        arrayFormat: 'repeat',
      })
    : '';
  const { data } = await http.get(`${controller}?${queryString}`);
  return data;
}

export async function FindOneNatureza(id) {
  const http = await get();
  const { data } = await http.get(`${controller}/${id}`);
  return data;
}

export async function PostNatureza(dado) {
  const http = await get();
  const { data } = await http.post(`${controller}`, dado);
  return data;
}

export async function PutNatureza(dado, id) {
  const http = await get();
  const { data } = await http.put(`${controller}/${id}`, dado);
  return data;
}

export async function RemoveNatureza(id) {
  const http = await get();
  const { data } = await http.delete(`${controller}/${id}`);
  return data;
}
