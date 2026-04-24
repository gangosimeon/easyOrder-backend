import { NextResponse } from 'next/server';

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

export function created<T>(data: T) {
  return NextResponse.json({ success: true, data }, { status: 201 });
}

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({ success: false, message, details }, { status: 400 });
}

export function unauthorized(message = 'Non authentifié') {
  return NextResponse.json({ success: false, message }, { status: 401 });
}

export function forbidden(message = 'Accès refusé') {
  return NextResponse.json({ success: false, message }, { status: 403 });
}

export function notFound(message = 'Ressource introuvable') {
  return NextResponse.json({ success: false, message }, { status: 404 });
}

export function conflict(message: string) {
  return NextResponse.json({ success: false, message }, { status: 409 });
}

export function serverError(message = 'Erreur serveur interne') {
  return NextResponse.json({ success: false, message }, { status: 500 });
}
