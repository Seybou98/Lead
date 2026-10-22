import { useMemo } from 'react';
import { qualificationGaps } from '../../domain/qualification/form';
import { usePublishedQualification } from './useQualificationForm';

/**
 * Ce qui manque à la qualification d'un lead selon le formulaire publié de son produit : le MÊME calcul que le serveur
 * (verrou de conversion), pour que l'aperçu des contrôles ne dise jamais « validé » quand le serveur refusera.
 */
export function useQualificationGaps(productCode: string | null, answers: Record<string, unknown>): string[] {
  const resolved = usePublishedQualification(productCode);
  return useMemo(() => qualificationGaps(resolved.form, answers, productCode), [resolved.form, answers, productCode]);
}
