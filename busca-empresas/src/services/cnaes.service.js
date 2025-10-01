// services/help.js
import qs from 'qs';
import { get } from '@/api';

const controller = 'Cnaes';

export async function FindAllCnaes(queryParams) {
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

export async function FindOneCnaes(id) {
  const http = await get();
  const { data } = await http.get(`${controller}/${id}`);
  return data;
}

export async function PostCnaes(dado) {
  const http = await get();
  const { data } = await http.post(`${controller}`, dado);
  return data;
}

export async function PutCnaes(dado, id) {
  const http = await get();
  const { data } = await http.put(`${controller}/${id}`, dado);
  return data;
}

export async function RemoveCnaes(id) {
  const http = await get();
  const { data } = await http.delete(`${controller}/${id}`);
  return data;
}
