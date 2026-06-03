import type { RemovableInterceptor } from '../../../primitives/InterceptorPrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveInterceptorScreenProps {
  interceptors: RemovableInterceptor[];
  onSelect: (interceptorName: string) => void;
  onExit: () => void;
}

export function RemoveInterceptorScreen({ interceptors, onSelect, onExit }: RemoveInterceptorScreenProps) {
  const items = interceptors.map(interceptor => ({
    id: interceptor.name,
    title: interceptor.name,
    description: 'Lambda Interceptor',
  }));

  return (
    <SelectScreen
      title="Select Interceptor to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
