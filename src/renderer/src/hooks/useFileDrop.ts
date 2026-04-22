import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * Attaches drag-and-drop file handling to a container div.
 * On drop, calls onPaths with the absolute filesystem paths of dragged files.
 * Returns a ref to attach to the container and an isDragging flag for styling.
 */
export function useFileDrop(onPaths: (paths: string[]) => void | Promise<void>) {
  const [isDragging, setIsDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const onPathsRef = useRef(onPaths)
  onPathsRef.current = onPaths

  const handlePaths = useCallback((paths: string[]) => {
    onPathsRef.current(paths)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setIsDragging(true)
    }
    const onDragLeave = () => setIsDragging(false)
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      const paths = files
        .map(f => window.api.getPathForFile(f))
        .filter(Boolean)
      if (paths.length) {
        handlePaths(paths)
        // Focus the input so the user can immediately edit/send
        const input = el.querySelector<HTMLInputElement>('input')
        if (input) setTimeout(() => input.focus(), 0)
      }
    }

    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [handlePaths])

  return { ref, isDragging }
}
